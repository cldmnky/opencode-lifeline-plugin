/**
 * Configuration loader for the Lifeline plugin.
 * Reads from .opencode/lifeline.json or ~/.config/opencode/lifeline.json
 * with environment variable overrides.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { LifelineConfig, AdvisorConfig } from "./types.ts"

const DEFAULT_CONFIG: LifelineConfig = {
  auto: true,
  action: "nudge",
  minRunsBetweenCalls: 5,
  triggerAfterConsecutiveFailures: 3,
  triggerAfterPlateauRuns: 6,
  maxCallsPerSession: 10,
  advisor: {
    provider: process.env.LIFELINE_ADVISOR_PROVIDER,
    model: process.env.LIFELINE_ADVISOR_MODEL,
    maxTokens: numberFromEnv("LIFELINE_ADVISOR_MAX_TOKENS", 4096),
    temperature: numberFromEnv("LIFELINE_ADVISOR_TEMPERATURE", 0.7),
    apiKey: process.env.LIFELINE_ADVISOR_API_KEY,
    baseUrl: process.env.LIFELINE_ADVISOR_BASE_URL,
  },
  includeContext: true,
  implicitDetection: true,
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw === "1" || raw.toLowerCase() === "true"
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function loadConfigFile(cwd: string): Partial<LifelineConfig> {
  const paths = [
    path.join(cwd, ".opencode", "lifeline.json"),
    path.join(os.homedir(), ".config", "opencode", "lifeline.json"),
    path.join(os.homedir(), ".opencode", "lifeline.json"),
  ]

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8")
        return JSON.parse(content) as Partial<LifelineConfig>
      }
    } catch (err) {
      // Log parse errors so users know their config was ignored
      console.error(`[opencode-lifeline] Failed to parse config at ${p}: ${(err as Error).message}. Using defaults.`)
    }
  }

  return {}
}

function normalizeAdvisorConfig(input: unknown, defaults: AdvisorConfig): AdvisorConfig {
  const obj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}

  return {
    provider: stringOr(obj.provider, defaults.provider),
    model: stringOr(obj.model, defaults.model),
    maxTokens: positiveNumber(obj.maxTokens, defaults.maxTokens),
    temperature: nonNegativeNumber(obj.temperature, defaults.temperature),
    apiKey: stringOr(obj.apiKey, defaults.apiKey),
    baseUrl: stringOr(obj.baseUrl, defaults.baseUrl),
  }
}

export function loadConfig(cwd: string): LifelineConfig {
  const fromFile = loadConfigFile(cwd)

  const action = fromFile.action === "ask" ? "ask" : "nudge"

  return {
    auto: typeof fromFile.auto === "boolean" ? fromFile.auto : DEFAULT_CONFIG.auto,
    action,
    minRunsBetweenCalls: nonNegativeNumber(
      fromFile.minRunsBetweenCalls,
      DEFAULT_CONFIG.minRunsBetweenCalls,
    ),
    triggerAfterConsecutiveFailures: positiveNumber(
      fromFile.triggerAfterConsecutiveFailures,
      DEFAULT_CONFIG.triggerAfterConsecutiveFailures,
    ),
    triggerAfterPlateauRuns: positiveNumber(
      fromFile.triggerAfterPlateauRuns,
      DEFAULT_CONFIG.triggerAfterPlateauRuns,
    ),
    maxCallsPerSession: positiveNumber(
      fromFile.maxCallsPerSession,
      DEFAULT_CONFIG.maxCallsPerSession,
    ),
    advisor: normalizeAdvisorConfig(fromFile.advisor, DEFAULT_CONFIG.advisor),
    includeContext:
      typeof fromFile.includeContext === "boolean"
        ? fromFile.includeContext
        : DEFAULT_CONFIG.includeContext,
    implicitDetection:
      typeof fromFile.implicitDetection === "boolean"
        ? fromFile.implicitDetection
        : DEFAULT_CONFIG.implicitDetection,
  }
}
