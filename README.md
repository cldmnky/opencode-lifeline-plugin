# OpenCode Lifeline Plugin

An [OpenCode](https://opencode.ai) plugin that lets a smaller/local model **phone-a-friend** (consult a stronger advisor model) when it gets stuck in an optimization or debugging loop. Hybrid stuck detection combines explicit experiment tracking via `log_experiment` with implicit heuristics (consecutive tool errors, no-progress plateau). Supports `nudge` mode (suggest advisor call) or `ask` mode (auto-call advisor).

## Features

- **Hybrid stuck detection**: Explicit tracking via `log_experiment` tool + implicit heuristics
- **Two action modes**:
  - `nudge` (default): Injects a message suggesting the agent call `phone_a_friend`
  - `ask`: Automatically calls the advisor and injects the response
- **Flexible advisor configuration**:
  - OpenCode-native: use any provider/model from your OpenCode registry
  - External API: use any OpenAI-compatible API directly
- **Session-scoped state**: Tracking resets per session; no persistence across sessions
- **Rate limiting**: Configurable minimum runs between calls and max calls per session

## Installation

OpenCode plugins are loaded from `.opencode/plugins/<name>/` directories (project-level or global).

### 1. Install OpenCode

```bash
# macOS / Linux
brew install opencode-ai

# Or via npm/pnpm/bun
npm install -g opencode-ai

# Verify
opencode --version
```

### 2. Create plugin directory

```bash
mkdir -p .opencode/plugins/opencode-lifeline
```

### 3. Copy plugin files

```bash
# Project-level (recommended for per-project config)
cp -r src/* .opencode/plugins/opencode-lifeline/

# Or globally
cp -r src/* ~/.config/opencode/plugins/opencode-lifeline/
```

For development, use a symlink so changes reload on restart:

```bash
ln -s $(pwd)/src ~/.config/opencode/plugins/opencode-lifeline
```

### 4. Configure the plugin

Create `lifeline.json` in one of the following locations (first found wins):

1. `.opencode/lifeline.json` — project-level
2. `~/.config/opencode/lifeline.json` — global (XDG)
3. `~/.opencode/lifeline.json` — global (legacy)

```json
{
  "auto": true,
  "action": "nudge",
  "minRunsBetweenCalls": 5,
  "triggerAfterConsecutiveFailures": 3,
  "triggerAfterPlateauRuns": 6,
  "maxCallsPerSession": 10,
  "advisor": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 4096,
    "temperature": 0.7
  },
  "implicitDetection": true,
  "includeContext": true
}
```

See [`lifeline.json.example`](./lifeline.json.example) for the full schema.

### 5. Restart OpenCode

OpenCode loads plugins at startup. Restart to pick up the new plugin.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auto` | `boolean` | `true` | Enable automatic stuck detection |
| `action` | `"nudge" \| "ask"` | `"nudge"` | `nudge` = suggest `phone_a_friend`; `ask` = auto-call advisor |
| `minRunsBetweenCalls` | `number` | `5` | Minimum turns between advisor calls |
| `triggerAfterConsecutiveFailures` | `number` | `3` | Trigger after N consecutive failures |
| `triggerAfterPlateauRuns` | `number` | `6` | Trigger after N runs without improvement |
| `maxCallsPerSession` | `number` | `10` | Max advisor calls per session |
| `advisor.provider` | `string` | — | OpenCode provider ID (e.g., `anthropic`, `openai`) |
| `advisor.model` | `string` | — | Model ID (e.g., `claude-sonnet-4-20250514`) |
| `advisor.maxTokens` | `number` | `4096` | Max tokens for advisor response |
| `advisor.temperature` | `number` | `0.7` | Temperature for advisor generation |
| `advisor.apiKey` | `string` | — | API key for external advisor calls |
| `advisor.baseUrl` | `string` | — | Base URL for external advisor (OpenAI-compatible) |
| `implicitDetection` | `boolean` | `true` | Enable implicit stuck detection |
| `includeContext` | `boolean` | `true` | Include session context in advisor prompts |

### Environment variables

Advisor options can be overridden via environment variables:

```bash
export LIFELINE_ADVISOR_PROVIDER=openai
export LIFELINE_ADVISOR_MODEL=gpt-5
export LIFELINE_ADVISOR_API_KEY=sk-...
export LIFELINE_ADVISOR_BASE_URL=https://api.openai.com/v1
export LIFELINE_ADVISOR_MAX_TOKENS=4096
export LIFELINE_ADVISOR_TEMPERATURE=0.7
```

Testing:

```bash
export LIFELINE_FAKE_RESPONSE="Test advisor response without spending tokens"
```

## Custom Tools

### `phone_a_friend`

Manually ask the advisor for help:

```
phone_a_friend
question: "We've tried three parser optimizations and all failed. What should we try next?"
mode: "next_experiment"
context: "Attempts: inline cache (segfault), arena reuse (no improvement), branchless scan (slower)"
max_ideas: 4
provider: "openai"
model: "gpt-5"
```

Modes:
- `ideas` — brainstorming
- `critique` — critique current approach
- `debug` — debugging help
- `next_experiment` — what to try next (default)

Overrides:
- `provider` — override the configured advisor provider for this call
- `model` — override the configured advisor model for this call

### `log_experiment`

Log an experiment result for explicit tracking:

```
log_experiment
run: 5
metric: 142.3
status: "discard"
description: "Tried memoizing parser tokens — no improvement"
```

Status values:
- `keep` — improvement kept
- `discard` — no improvement or regression
- `crash` — caused a crash
- `checks_failed` — tests/checks failed

Logs are appended to `autoresearch.jsonl` in the current directory.

## How It Works

### Explicit Detection

When the agent uses `log_experiment` to track optimization attempts, the plugin reads `autoresearch.jsonl` and triggers when:

1. **Consecutive failures**: N `discard`/`crash`/`checks_failed` in a row
2. **Plateau**: N runs without a `keep`

### Implicit Detection

Even without `log_experiment`, the plugin detects stuck patterns by monitoring:

1. **Consecutive tool errors**: Repeated failures of the same tool
2. **No-progress plateau**: Many turns without successful file edits/writes
3. **Run counter**: Incremented on each `session.idle` event

Implicit detection only activates after a coding-relevant tool (`bash`, `edit`, `write`, `grep`, `glob`, `read`) has been used, preventing false triggers on purely conversational sessions.

### Trigger Action

- **`nudge` mode** (default, recommended):
  Injects a context message suggesting the agent call `phone_a_friend`. Costs nothing until the agent decides to act.

- **`ask` mode**:
  Automatically calls the advisor model and injects the response. Useful for unattended runs but consumes tokens immediately.

## Development

```bash
# Type-check
npm run check

# Test with fake response (no tokens spent)
export LIFELINE_FAKE_RESPONSE="Try measuring phase timings before further code changes."
```

## License

MIT
