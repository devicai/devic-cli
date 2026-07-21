# @devicai/cli

CLI for the [Devic AI Platform](https://devic.ai) API. Agent-first — optimized for LLM/agent consumption with structured JSON output, machine-readable errors, and efficient polling.

## Installation

```bash
npm install -g @devicai/cli
```

Or run directly with npx:

```bash
npx @devicai/cli --help
```

## Authentication

Get your API key from the [Devic dashboard](https://app.devic.ai/api-keys).

```bash
# Store credentials
devic auth login --api-key devic-your-key

# Check status
devic auth status

# Or use environment variables (takes precedence)
export DEVIC_API_KEY=devic-your-key
export DEVIC_BASE_URL=https://api.devic.ai  # optional
```

## Output Modes

- **JSON** (default when piped or non-TTY) — structured, machine-readable
- **Human** (default in terminal) — formatted tables and key-value display

Override with `--output json` or `--output human` (`-o` for short).

Errors always go to stderr as JSON: `{"error":"...","code":"..."}`.

Exit codes: `0` success, `1` error, `2` auth required, `3` poll timeout.

## Commands

### Assistants

```bash
# List assistants
devic assistants list
devic assistants list --external

# Get assistant details
devic assistants get <identifier>

# Chat with an assistant (async + polling by default)
devic assistants chat <identifier> -m "Hello"
devic assistants chat <identifier> -m "Hello" --no-wait   # sync mode
devic assistants chat <identifier> -m "Hello" --chat-uid <uid>  # continue conversation
devic assistants chat <identifier> -m "Hello" --provider anthropic --model claude-3-opus

# Stop an in-progress chat
devic assistants stop <identifier> <chatUid>

# Chat histories
devic assistants chats list <identifier> --limit 20
devic assistants chats get <identifier> <chatUid>
devic assistants chats search --assistant default --tags support,urgent --start-date 2024-01-01
```

### Agents

```bash
# CRUD
devic agents list --limit 20
devic agents get <agentId>
devic agents create --name "My Agent" --description "Does things"
devic agents create --from-json agent-config.json
devic agents update <agentId> --name "New Name"
devic agents delete <agentId>

# Threads
devic agents threads create <agentId> -m "Analyze Q4 sales"
devic agents threads create <agentId> -m "Analyze Q4 sales" --wait  # poll until done
devic agents threads list <agentId> --state COMPLETED --limit 20
devic agents threads get <threadId> --with-tasks

# Watch an execution (short window, reports only what changed since last check)
devic agents threads watch <threadId>
devic agents threads watch <threadId> --wait 5 --window 35 --interval 3
devic agents threads watch <threadId> --until approval   # return only on approval/terminal

# Thread control
devic agents threads approve <threadId> -m "Proceed"
devic agents threads reject <threadId> -m "Try a different approach"
devic agents threads pause <threadId>
devic agents threads resume <threadId>
devic agents threads complete <threadId> --state TERMINATED

# Evaluation
devic agents threads evaluate <threadId>

# Cost tracking
devic agents costs daily <agentId> --start-date 2024-01-01 --end-date 2024-01-31
devic agents costs monthly <agentId> --start-month 2024-01 --end-month 2024-06
devic agents costs summary <agentId>
```

### Tool Servers

```bash
# CRUD
devic tool-servers list
devic tool-servers get <id>
devic tool-servers create --name "My API" --url https://api.example.com
devic tool-servers create --from-json server-config.json
devic tool-servers update <id> --enabled true
devic tool-servers delete <id>
devic tool-servers clone <id>

# Definition
devic tool-servers definition <id>
devic tool-servers update-definition <id> --from-json definition.json

# Tools
devic tool-servers tools list <serverId>
devic tool-servers tools get <serverId> <toolName>
devic tool-servers tools add <serverId> --from-json tool.json
devic tool-servers tools update <serverId> <toolName> --from-json updates.json
devic tool-servers tools delete <serverId> <toolName>
devic tool-servers tools test <serverId> <toolName> --from-json '{"city":"London"}'
```

### Feedback

```bash
# Chat feedback
devic feedback submit-chat <identifier> <chatUid> --message-id <msgId> --positive
devic feedback submit-chat <identifier> <chatUid> --message-id <msgId> --negative --comment "Not accurate"
devic feedback list-chat <identifier> <chatUid>

# Thread feedback
devic feedback submit-thread <threadId> --message-id <msgId> --positive
devic feedback list-thread <threadId>
```

## JSON Input

For complex payloads, use `--from-json` with a file path or `-` for stdin:

```bash
# From file
devic agents create --from-json agent-config.json

# From stdin
echo '{"name":"My Agent","description":"Does things"}' | devic agents create --from-json -

# Pipe from another command
cat config.json | devic tool-servers create --from-json -
```

## Polling & Streaming

When using `--wait`, the CLI polls async operations with exponential backoff and outputs NDJSON status lines to stdout:

```bash
devic assistants chat default -m "Analyze this data" --wait
# {"type":"chat_status","chatUid":"...","status":"processing","timestamp":1234567890}
# {"type":"chat_status","chatUid":"...","status":"completed","timestamp":1234567891}
# { ...final result... }

devic agents threads create <agentId> -m "Run analysis" --wait
# {"type":"thread_status","threadId":"...","state":"processing","tasks":[...],"timestamp":1234567890}
# {"type":"thread_status","threadId":"...","state":"completed","tasks":[...],"timestamp":1234567891}
# { ...final result... }
```

Polling parameters:
- **Chats**: 1s initial, 1.5x backoff, 10s max interval, 5min timeout
- **Threads**: 2s initial, 1.5x backoff, 15s max interval, 10min timeout

## Watching an execution

`--wait` blocks until the run finishes, which does not fit an agent driving the CLI from a
sandbox (commands there are killed at ~45s). `agents threads watch` is the incremental
alternative: it watches for a short window, reports **only what changed since the previous
call**, and says whether watching further is worth it.

```bash
devic agents threads watch <threadId> --wait 5 --window 35 --interval 3
```

| Flag | Default | Meaning |
|---|---|---|
| `--wait <s>` | `0` | sleep before looking, so consecutive checks are spaced without an external `sleep` |
| `--window <s>` | `35` | how long to keep watching |
| `--interval <s>` | `3` | how often to re-check |
| `--since <cursor>` | — | only report activity after a cursor returned by an earlier watch |
| `--until <event>` | `change` | `change`, `approval` or `terminal` |
| `--with-tasks` | off | include the external tasks API (one extra HTTP call per check) |

`--wait` + `--window` must be **≤ 40s**.

State between calls lives in `~/.cache/devic/watch/<threadId>.json`: it holds the previous
fingerprint (state + message count + task signature), so a thread that sits in `processing`
while still producing messages is not mistaken for a stuck one — and vice versa. Records are
deleted when the thread finishes and pruned after 24h.

Exit codes drive the decision:

| Code | `reason` | What it means |
|---|---|---|
| 0 | `terminal` | finished (`completed` / `failed` / `terminated` / `approval_rejected`) |
| 10 | `approval_required` | a human has to approve or reject; nothing moves until then |
| 11 | `waiting_for_response`, `paused`, `limit_exceeded` | blocked on something external |
| 12 | `progress`, `window_elapsed` | still running — call again with the returned cursor |
| 13 | `stalled` | nothing changed across several consecutive checks |
| 1 | — | error (thread not found, bad budget, auth) |

The `advice` field (`continue`, `slow_down`, `human_action_required`, `stop_polling`) and
`suggestedNext` carry the recommended cadence, and `diagnostics` explains *why* a thread is
not moving — disabled agent, agent at its concurrency limit, queue cron delay, pending
approval, scheduled resume time, no hot watchdog for wedged threads.

## Configuration

Credentials are stored in `~/.config/devic/config.json`. Environment variables take precedence:

| Variable | Description |
|----------|-------------|
| `DEVIC_API_KEY` | API key (overrides stored config) |
| `DEVIC_BASE_URL` | API base URL (default: `https://api.devic.ai`) |

## Requirements

- Node.js 20+
