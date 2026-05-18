/**
 * In-memory session state management.
 * State persists only for the lifetime of the session.
 */

import type { SessionState, ExperimentRun, ToolOutcome } from "./types.ts"

const states = new Map<string, SessionState>()

export function getState(sessionID: string): SessionState {
  if (!states.has(sessionID)) {
    states.set(sessionID, createState(sessionID))
  }
  return states.get(sessionID)!
}

export function createState(sessionID: string): SessionState {
  return {
    sessionID,
    runCount: 0,
    callsThisSession: 0,
    lastCallRun: null,
    lastReason: null,
    lastAdvice: null,
    experimentRuns: [],
    recentToolOutcomes: [],
    lastProgressRun: null,
    processing: false,
  }
}

export function deleteState(sessionID: string): void {
  states.delete(sessionID)
}

export function recordRun(sessionID: string): SessionState {
  const state = getState(sessionID)
  state.runCount += 1
  return state
}

export function recordToolOutcome(sessionID: string, outcome: ToolOutcome): SessionState {
  const state = getState(sessionID)
  state.recentToolOutcomes.push(outcome)
  // Keep only last 50 outcomes
  if (state.recentToolOutcomes.length > 50) {
    state.recentToolOutcomes = state.recentToolOutcomes.slice(-50)
  }
  return state
}

export function recordProgress(sessionID: string): SessionState {
  const state = getState(sessionID)
  state.lastProgressRun = state.runCount
  return state
}

export function recordExperimentRun(sessionID: string, run: ExperimentRun): SessionState {
  const state = getState(sessionID)
  state.experimentRuns.push(run)
  return state
}

export function recordAdvisorCall(
  sessionID: string,
  reason: string,
  advice: string,
): SessionState {
  const state = getState(sessionID)
  state.callsThisSession += 1
  state.lastCallRun = state.runCount
  state.lastReason = reason
  state.lastAdvice = advice
  return state
}

export function setProcessing(sessionID: string, processing: boolean): void {
  const state = getState(sessionID)
  state.processing = processing
}
