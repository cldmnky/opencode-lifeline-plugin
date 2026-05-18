/**
 * Advisor integration — supports both OpenCode-native model calls
 * and external API calls.
 */

import type { LifelineConfig, AdvisorResult, AdvisorParams } from "./types.ts"

function buildAdvisorPrompt(params: AdvisorParams, contextText: string): string {
  const mode = params.mode ?? "next_experiment"
  const maxIdeas = Math.max(1, Math.floor(params.max_ideas ?? 5))

  const parts = [
    "You are a senior research advisor helping a smaller coding model that is stuck in an optimization or debugging loop.",
    "Do not write full patches. Give strategic, testable advice the smaller model can execute locally.",
    "Avoid benchmark cheating and call out overfitting risks.",
    `Mode: ${mode}`,
    `Return at most ${maxIdeas} ranked ideas. For each idea include: rationale, concrete next step, and expected signal.`,
    "",
    contextText,
    "",
    `Question:\n${params.question}`,
  ]

  return parts.filter(Boolean).join("\n")
}

async function callExternalAdvisor(
  config: LifelineConfig,
  prompt: string,
): Promise<AdvisorResult> {
  const advisor = config.advisor
  if (!advisor.apiKey) {
    throw new Error(
      "External advisor configured but no API key provided. Set advisor.apiKey in config or LIFELINE_ADVISOR_API_KEY env var.",
    )
  }

  const baseUrl = advisor.baseUrl ?? "https://api.openai.com/v1"
  const model = advisor.model ?? "gpt-4"

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${advisor.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: advisor.maxTokens,
      temperature: advisor.temperature,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Advisor API error (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = data.choices?.[0]?.message?.content ?? "No response from advisor."

  return {
    text,
    provider: baseUrl,
    model,
  }
}

async function callNativeAdvisor(
  client: any,
  sessionID: string,
  config: LifelineConfig,
  prompt: string,
): Promise<AdvisorResult> {
  const advisor = config.advisor
  if (!advisor.provider || !advisor.model) {
    throw new Error(
      "Native advisor configured but no provider/model specified. Set advisor.provider and advisor.model in config.",
    )
  }

  // Use OpenCode's SDK to prompt the advisor model.
  // noReply: true prevents this from triggering a model response turn and keeps the
  // exchange out of session history. The caller is responsible for injecting the response.
  const result = await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      model: { providerID: advisor.provider, modelID: advisor.model },
      parts: [{ type: "text", text: prompt }],
    },
  })

  const text = result.data?.parts?.[0]?.text ?? result.data?.info?.text ?? "No response from advisor."

  return {
    text,
    provider: advisor.provider,
    model: advisor.model,
  }
}

export async function askAdvisor(
  client: any,
  sessionID: string,
  config: LifelineConfig,
  params: AdvisorParams,
  contextText: string,
): Promise<AdvisorResult> {
  // Read at call time so test mutations to process.env are picked up
  const fakeResponse = process.env.LIFELINE_FAKE_RESPONSE
  if (fakeResponse !== undefined) {
    return {
      text: fakeResponse,
      provider: "fake",
      model: "env",
      fake: true,
    }
  }

  const prompt = buildAdvisorPrompt(params, contextText)

  // If apiKey is provided, use external API
  if (config.advisor.apiKey) {
    return callExternalAdvisor(config, prompt)
  }

  // Otherwise use OpenCode native model call
  return callNativeAdvisor(client, sessionID, config, prompt)
}
