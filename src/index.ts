/**
 * OpenCode Lifeline Plugin
 *
 * Lets a smaller/local model "phone a friend" (stronger advisor model) when stuck.
 * Hybrid detection: explicit via log_experiment tool + implicit via session heuristics.
 */

import { tool, type Plugin } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"

import { loadConfig } from "./lib/config.ts"
import {
  getState,
  recordRun,
  recordToolOutcome,
  recordProgress,
  recordExperimentRun,
  recordAdvisorCall,
  setProcessing,
} from "./lib/state.ts"
import { detectStuck, readAutoresearchData } from "./lib/detector.ts"
import { askAdvisor } from "./lib/advisor.ts"
import type { TriggerResult, AdvisorParams } from "./lib/types.ts"

// Best-effort tracking of the currently active session
let activeSessionID: string | null = null

async function handleTrigger(
  ctx: any,
  config: ReturnType<typeof loadConfig>,
  result: TriggerResult,
  sessionID: string,
): Promise<void> {
  const state = getState(sessionID)

  if (config.action === "nudge") {
    // Inject a nudge message suggesting the agent call phone_a_friend
    const nudgeText = [
      `[LIFELINE] The agent appears to be stuck: ${result.reason}.`,
      `Consider calling the \`phone_a_friend\` tool to get strategic advice from a stronger advisor model.`,
      `Example: ask for "next_experiment" ideas with your current context.`,
    ].join("\n")

    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: nudgeText }],
        },
      })
      recordAdvisorCall(sessionID, result.reason, "[nudge sent]")
    } catch (err) {
      await ctx.client.app.log({
        body: {
          service: "opencode-lifeline",
          level: "error",
          message: `Failed to send nudge: ${(err as Error).message}`,
        },
      })
    }
  } else {
    // "ask" mode: automatically call the advisor and inject the response
    setProcessing(sessionID, true)
    try {
      const contextText = await buildContext(ctx, config, sessionID)
      const advice = await askAdvisor(
        ctx.client,
        sessionID,
        config,
        {
          question: `The agent is stuck: ${result.reason}. What should we try next?`,
          mode: "next_experiment",
        },
        contextText,
      )

      const advisorText = [
        `[LIFELINE ADVISOR — ${advice.provider}/${advice.model}${advice.fake ? " (FAKE)" : ""}]`,
        advice.text,
      ].join("\n\n")

      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: advisorText }],
        },
      })

      recordAdvisorCall(sessionID, result.reason, advice.text)
    } catch (err) {
      await ctx.client.app.log({
        body: {
          service: "opencode-lifeline",
          level: "error",
          message: `Advisor call failed: ${(err as Error).message}`,
        },
      })

      // Fall back to nudge
      const fallbackText = `[LIFELINE] Stuck detected (${result.reason}), but advisor call failed. Try using \`phone_a_friend\` manually.`
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: fallbackText }],
        },
      })
    } finally {
      setProcessing(sessionID, false)
    }
  }
}

async function buildContext(ctx: any, config: ReturnType<typeof loadConfig>, sessionID: string): Promise<string> {
  const parts: string[] = []

  // Include autoresearch context if available
  if (config.includeContext) {
    const data = readAutoresearchData(ctx.directory)
    if (data.runs.length > 0) {
      const recent = data.runs
        .slice(-8)
        .map((r: { run: number; status: string; metric: number; description?: string }) => `#${r.run} ${r.status} ${data.metricName}=${r.metric} ${r.description ?? ""}`.trim())
        .join("\n")
      parts.push(`Recent autoresearch runs:\n${recent}`)
    }

    // Try to include recent session messages
    try {
      const messages = await ctx.client.session.messages({ path: { id: sessionID } })
      if (messages.data && messages.data.length > 0) {
        const recentMessages = messages.data.slice(-10)
        const summary = recentMessages
          .map((m: any) => {
            const text = m.parts?.map((p: any) => p.text ?? "").join(" ") ?? ""
            return `${m.info?.role ?? "unknown"}: ${text.slice(0, 200)}`
          })
          .join("\n")
        parts.push(`Recent session context:\n${summary}`)
      }
    } catch {
      // Ignore message fetch errors
    }
  }

  return parts.filter(Boolean).join("\n\n")
}

export const LifelinePlugin: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory)

  await ctx.client.app.log({
    body: {
      service: "opencode-lifeline",
      level: "info",
      message: `Lifeline plugin loaded. Auto=${config.auto}, Action=${config.action}, Advisor=${config.advisor.provider ?? "none"}/${config.advisor.model ?? "none"}`,
    },
  })

  return {
    // Track active session from events
    event: async ({ event }) => {
      const props = event.properties as any
      const sid = props?.sessionID as string | undefined
      if (sid) {
        activeSessionID = sid
      }

      if (event.type === "session.created" && sid) {
        getState(sid)
      }

      if (event.type === "session.idle" && sid) {
        const state = recordRun(sid)
        const result = detectStuck(state, config, ctx.directory)

        if (result.triggered) {
          await handleTrigger(ctx, config, result, sid)
        }
      }
    },

    // Track successful tool calls for implicit progress detection
    "tool.execute.after": async (input: any, output: any) => {
      const toolName = input.tool as string
      // The hook output shape is: { title, output, metadata }
      // Infer failure from metadata.error or by checking output string for error patterns
      const meta = output.metadata as Record<string, unknown> | undefined
      const outStr = (output.output as string | undefined) ?? ""
      const success =
        meta?.error === undefined &&
        meta?.exitCode !== 1 &&
        !(typeof meta?.exitCode === "number" && meta.exitCode !== 0) &&
        !outStr.startsWith("Error:") &&
        !outStr.startsWith("error:")
      // Prefer session ID from the tool execution context; fall back to module-level tracker
      const sessionID: string | null = (input.sessionID as string | undefined) ?? activeSessionID

      if (sessionID) {
        // Debug: log tool outcome to confirm hook fires
        await ctx.client.app.log({
          body: {
            service: "opencode-lifeline",
            level: "info",
            message: `tool.execute.after: tool=${toolName} success=${success} exitCode=${meta?.exitCode ?? "n/a"} sessionID=${sessionID}`,
          },
        }).catch(() => {})

        recordToolOutcome(sessionID, {
          tool: toolName,
          success,
          timestamp: Date.now(),
          error: output.error,
        })

        // Successful file modifications count as progress
        if (success && (toolName === "edit" || toolName === "write")) {
          recordProgress(sessionID)
        }
      }
    },

    // Custom tools
    tool: {
      phone_a_friend: tool({
        description:
          "Ask a stronger advisor model for strategic guidance when stuck. Use this when you've tried multiple approaches without success.",
        args: {
          question: tool.schema
            .string()
            .describe("Specific question for the advisor. Be concise and focused."),
          context: tool.schema
            .string()
            .optional()
            .describe("Relevant context: recent errors, attempted solutions, current state."),
          mode: tool.schema
            .enum(["ideas", "critique", "debug", "next_experiment"])
            .optional()
            .describe("Type of advice desired. Default: next_experiment."),
          max_ideas: tool.schema
            .number()
            .optional()
            .describe("Maximum number of ideas to request. Default: 5."),
          provider: tool.schema
            .string()
            .optional()
            .describe("Override advisor provider for this call."),
          model: tool.schema
            .string()
            .optional()
            .describe("Override advisor model for this call."),
        },
        async execute(args: AdvisorParams, context: any) {
          const sessionID = context.sessionID as string | undefined
          if (!sessionID) {
            return "Error: No session ID available."
          }

          setProcessing(sessionID, true)
          try {
            const contextText = await buildContext(
              { client: ctx.client, directory: (context.directory as string | undefined) ?? ctx.directory },
              config,
              sessionID,
            )
            const result = await askAdvisor(
              ctx.client,
              sessionID,
              config,
              args,
              contextText,
            )

            recordAdvisorCall(
              sessionID,
              `Manual phone_a_friend (${args.mode ?? "next_experiment"})`,
              result.text,
            )

            return [
              `[Advisor: ${result.provider}/${result.model}${result.fake ? " (FAKE)" : ""}]`,
              result.text,
            ].join("\n\n")
          } catch (err) {
            return `Advisor call failed: ${(err as Error).message}`
          } finally {
            setProcessing(sessionID, false)
          }
        },
      }),

      log_experiment: tool({
        description:
          "Log the result of an experiment or optimization attempt. Writes to autoresearch.jsonl for tracking and lifeline trigger detection.",
        args: {
          run: tool.schema.number().describe("Experiment run number."),
          metric: tool.schema.number().describe("Measured metric value (e.g., time in ms, score)."),
          status: tool.schema
            .enum(["keep", "discard", "crash", "checks_failed"])
            .describe("Outcome of this experiment."),
          description: tool.schema
            .string()
            .optional()
            .describe("Brief description of what was tried."),
        },
        async execute(
          args: {
            run: number
            metric: number
            status: "keep" | "discard" | "crash" | "checks_failed"
            description?: string
          },
          context: any,
        ) {
          const sessionID = context.sessionID as string | undefined
          const directory = context.directory as string
          const line = JSON.stringify({
            run: args.run,
            metric: args.metric,
            status: args.status,
            description: args.description,
            timestamp: Date.now(),
          })

          const jsonlPath = path.join(directory, "autoresearch.jsonl")
          try {
            fs.appendFileSync(jsonlPath, line + "\n")
          } catch (err) {
            return `Failed to write to autoresearch.jsonl: ${(err as Error).message}`
          }

          if (sessionID) {
            recordExperimentRun(sessionID, {
              run: args.run,
              metric: args.metric,
              status: args.status,
              timestamp: Date.now(),
              description: args.description,
            })

            // Keep runs count as progress
            if (args.status === "keep") {
              recordProgress(sessionID)
            }
          }

          return `Logged experiment #${args.run}: ${args.status} (metric=${args.metric})`
        },
      }),
    },
  }
}

export default LifelinePlugin
