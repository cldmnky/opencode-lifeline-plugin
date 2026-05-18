/**
 * Stuck detection logic — hybrid explicit + implicit.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type {
  LifelineConfig,
  SessionState,
  ExperimentRun,
  TriggerResult,
  ToolOutcome,
} from "./types.ts"

// Maximum number of recent runs to read from autoresearch.jsonl
const MAX_RECENT_RUNS = 50

interface AutoresearchData {
  runs: ExperimentRun[]
  direction: "lower" | "higher"
  metricName: string
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function readAutoresearchData(directory: string): AutoresearchData {
  const jsonlPath = path.join(directory, "autoresearch.jsonl")
  if (!fs.existsSync(jsonlPath)) {
    return { runs: [], direction: "lower", metricName: "metric" }
  }

  try {
    const content = fs.readFileSync(jsonlPath, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    const runs: ExperimentRun[] = []
    let direction: "lower" | "higher" = "lower"
    let metricName = "metric"

    for (const line of lines) {
      const entry = parseJsonlLine(line)
      if (!entry) continue

      if (entry.type === "config") {
        direction = entry.bestDirection === "higher" ? "higher" : "lower"
        if (typeof entry.metricName === "string") metricName = entry.metricName
        continue
      }

      if (typeof entry.run !== "number") continue
      const status = entry.status
      if (
        status !== "keep" &&
        status !== "discard" &&
        status !== "crash" &&
        status !== "checks_failed"
      ) {
        continue
      }

      runs.push({
        run: entry.run,
        metric: typeof entry.metric === "number" ? entry.metric : 0,
        status,
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
        description: typeof entry.description === "string" ? entry.description : undefined,
      })
    }

    return { runs: runs.slice(-MAX_RECENT_RUNS), direction, metricName }
  } catch {
    return { runs: [], direction: "lower", metricName: "metric" }
  }
}

function detectExplicitStuck(
  state: SessionState,
  config: LifelineConfig,
  directory: string,
): TriggerResult {
  const data = readAutoresearchData(directory)
  const runs = data.runs

  if (runs.length === 0) {
    return { triggered: false, reason: "", mode: "explicit" }
  }

  // Update state with latest runs
  state.experimentRuns = runs

  // Check consecutive failures
  const failureStatuses = new Set<string>(["discard", "crash", "checks_failed"])
  let consecutiveFailures = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (failureStatuses.has(runs[i].status)) {
      consecutiveFailures++
    } else {
      break
    }
  }

  if (consecutiveFailures >= config.triggerAfterConsecutiveFailures) {
    return {
      triggered: true,
      reason: `${consecutiveFailures} consecutive failures (explicit)`,
      mode: "explicit",
    }
  }

  // Check plateau: no keep for N runs
  let runsSinceLastKeep = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === "keep") {
      break
    }
    runsSinceLastKeep++
  }

  if (runsSinceLastKeep >= config.triggerAfterPlateauRuns) {
    return {
      triggered: true,
      reason: `${runsSinceLastKeep} runs without improvement (explicit plateau)`,
      mode: "explicit",
    }
  }

  return { triggered: false, reason: "", mode: "explicit" }
}

function detectImplicitStuck(state: SessionState, config: LifelineConfig): TriggerResult {
  if (!config.implicitDetection) {
    return { triggered: false, reason: "", mode: "implicit" }
  }

  const outcomes = state.recentToolOutcomes
  if (outcomes.length === 0) {
    return { triggered: false, reason: "", mode: "implicit" }
  }

  // 1. Consecutive tool errors in recent outcomes
  const recentOutcomes = outcomes.slice(-20)
  let consecutiveErrors = 0
  for (let i = recentOutcomes.length - 1; i >= 0; i--) {
    if (!recentOutcomes[i].success) {
      consecutiveErrors++
    } else {
      break
    }
  }

  if (consecutiveErrors >= config.triggerAfterConsecutiveFailures) {
    return {
      triggered: true,
      reason: `${consecutiveErrors} consecutive tool errors (implicit)`,
      mode: "implicit",
    }
  }

  // 2. Plateau: no progress for N runs — only after progress has been recorded at least once
  if (state.lastProgressRun !== null) {
    const runsSinceProgress = state.runCount - state.lastProgressRun
    if (state.runCount > 0 && runsSinceProgress >= config.triggerAfterPlateauRuns) {
      return {
        triggered: true,
        reason: `${runsSinceProgress} runs without measurable progress (implicit plateau)`,
        mode: "implicit",
      }
    }
  }

  // 3. Repeated consecutive failure pattern: same tool failing consecutively
  const toolConsecutiveErrors = new Map<string, number>()
  // Walk backwards to count consecutive failures per tool
  for (let i = recentOutcomes.length - 1; i >= 0; i--) {
    const outcome = recentOutcomes[i]
    if (!outcome.success) {
      toolConsecutiveErrors.set(outcome.tool, (toolConsecutiveErrors.get(outcome.tool) || 0) + 1)
    } else {
      // A success resets the consecutive count for that tool
      toolConsecutiveErrors.delete(outcome.tool)
    }
  }

  for (const [tool, count] of toolConsecutiveErrors.entries()) {
    if (count >= config.triggerAfterConsecutiveFailures) {
      return {
        triggered: true,
        reason: `Tool '${tool}' failed ${count} times (implicit)`,
        mode: "implicit",
      }
    }
  }

  return { triggered: false, reason: "", mode: "implicit" }
}

export function detectStuck(
  state: SessionState,
  config: LifelineConfig,
  directory: string,
): TriggerResult {
  // Check basic rate limits first
  if (!config.auto) {
    return { triggered: false, reason: "Auto-detection disabled", mode: "explicit" }
  }

  if (state.callsThisSession >= config.maxCallsPerSession) {
    return {
      triggered: false,
      reason: `Max calls per session (${config.maxCallsPerSession}) reached`,
      mode: "explicit",
    }
  }

  if (
    state.lastCallRun !== null &&
    state.runCount - state.lastCallRun < config.minRunsBetweenCalls
  ) {
    return {
      triggered: false,
      reason: `Too soon since last call (${state.runCount - state.lastCallRun} < ${config.minRunsBetweenCalls})`,
      mode: "explicit",
    }
  }

  if (state.processing) {
    return { triggered: false, reason: "Already processing", mode: "explicit" }
  }

  // Try explicit detection first
  const explicit = detectExplicitStuck(state, config, directory)
  if (explicit.triggered) {
    return explicit
  }

  // Fall back to implicit detection
  return detectImplicitStuck(state, config)
}
