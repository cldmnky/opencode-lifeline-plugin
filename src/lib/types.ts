/**
 * Type definitions for the OpenCode Lifeline plugin.
 */

export interface AdvisorConfig {
  /** Provider ID from OpenCode registry (e.g., "anthropic", "openai") */
  provider?: string
  /** Model ID (e.g., "claude-sonnet-4-20250514") */
  model?: string
  /** Maximum tokens for advisor response */
  maxTokens: number
  /** Temperature for advisor generation */
  temperature: number
  /** Optional API key for external advisor calls */
  apiKey?: string
  /** Optional base URL for external advisor calls */
  baseUrl?: string
}

export interface LifelineConfig {
  /** Enable automatic stuck detection */
  auto: boolean
  /** Action when stuck: "nudge" (suggest phone_a_friend) or "ask" (auto-call advisor) */
  action: "nudge" | "ask"
  /** Minimum runs between advisor calls */
  minRunsBetweenCalls: number
  /** Trigger after this many consecutive failures */
  triggerAfterConsecutiveFailures: number
  /** Trigger after this many runs without improvement */
  triggerAfterPlateauRuns: number
  /** Maximum advisor calls per session */
  maxCallsPerSession: number
  /** Advisor model configuration */
  advisor: AdvisorConfig
  /** Include session context in advisor prompts */
  includeContext: boolean
  /** Enable implicit stuck detection (when no log_experiment tool is used) */
  implicitDetection: boolean
}

export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed"

export interface ExperimentRun {
  run: number
  metric: number
  status: ExperimentStatus
  timestamp?: number
  description?: string
}

export interface SessionState {
  sessionID: string
  /** Number of turns/runs in this session */
  runCount: number
  /** Number of advisor calls made this session */
  callsThisSession: number
  /** Run number of last advisor call */
  lastCallRun: number | null
  /** Reason for last trigger */
  lastReason: string | null
  /** Last advice received */
  lastAdvice: string | null
  /** Explicit experiment runs from autoresearch.jsonl */
  experimentRuns: ExperimentRun[]
  /** Implicit: recent tool call outcomes */
  recentToolOutcomes: ToolOutcome[]
  /** Implicit: last run with successful progress (null = no progress recorded yet) */
  lastProgressRun: number | null
  /** Whether currently processing (prevent double triggers) */
  processing: boolean
}

export interface ToolOutcome {
  tool: string
  success: boolean
  timestamp: number
  error?: string
}

export interface TriggerResult {
  triggered: boolean
  reason: string
  mode: "explicit" | "implicit"
}

export interface AdvisorResult {
  text: string
  provider: string
  model: string
  fake?: boolean
}

export interface AdvisorParams {
  question: string
  context?: string
  mode?: "ideas" | "critique" | "debug" | "next_experiment"
  max_ideas?: number
  provider?: string
  model?: string
}
