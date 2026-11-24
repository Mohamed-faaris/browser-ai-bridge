# ACP Gateway Integration Plan

Status: ACP v1 browser chat, provider switching, a strict tool protocol and an initial permission-gated workspace executor are committed on the feature branch. Runtime tests and a live T3 handshake have not yet been executed. This document tracks implemented behavior separately from the remaining validation work.

## Selected architecture

Run this repository as a standalone local ACP agent launched by T3 Code through **Settings → Providers → Add provider → Local ACP command**.

- T3 remains the coding UI and mediates ACP permission requests.
- This gateway owns browser-backed model sessions and (when explicitly enabled) local coding-tool execution.
- Each ACP session maps to a project working directory, selected web provider and browser conversation/session. ACP metadata, the task transcript and replayable session updates are persisted in a private local state directory; browser tabs remain process-local runtime resources.
- All file writes and shell commands must go through gateway-owned validation and an ACP permission request before execution.
- The gateway must fail closed on malformed tool proposals, paths outside the session workspace, unknown permissions, provider UI drift and ambiguous execution outcomes.

This is the **gateway-executes** model. T3 approval authorizes the gateway to act; T3 does not itself execute the gateway's local filesystem or terminal operation.

## Repository audit: existing pieces

### Browser and provider lifecycle

- `src/browser/connection.js` exports `connectToBrowser()`; it attaches to an existing CDP Chrome or launches one and returns the browser context.
- `src/browser.js` re-exports browser connection/context lifecycle.
- `src/ai/shared/BaseProvider.js` uses the shared browser context and opens/reuses provider tabs.
- `src/session/Creator.js` maps provider IDs to ChatGPT, Gemini, DeepSeek, Grok, Copilot and generic provider classes.
- `src/session/Manager.js` exposes `createSession(providerId, mode)`, `getSession(id)`, `closeSession(id)`, `closeAllSessions()` and `listSessions()`.
- `SessionManager.createSession()` starts a fresh provider conversation via `engine.startNewChat()`. Therefore the ACP layer should create one provider session per ACP session and reuse that engine for subsequent prompts; it must not call `createSession()` for every turn.
- `src/session/Pool.js` and `src/session/TabJanitor.js` manage provider browser-tab capacity and lifecycle.

### Existing agent endpoint is not a safe executor

- `src/routes/agent.js` creates `AgentOrchestrator` and calls its `runTask()`.
- `src/agent/Orchestrator.js` extracts JSON-like content from ordinary model text and loops over tool calls.
- `src/agent/ToolRegistry.js` currently has a mock `read_file` handler and returns mock content. It is not a real workspace executor.
- The current path does not implement ACP, ACP permission requests, strict per-tool schemas, workspace containment, or durable task recovery.

Do not expose the current `defaultRegistry` as a trusted coding tool implementation. A new ACP tool protocol and executor must be developed with explicit schemas and tests.

### Startup constraints

- `src/index.js` starts the Express API server, connects Chrome, runs `runLoginSequence()`, initializes the session pool and starts the tab janitor.
- `src/startup/authSequence.js` uses terminal readline prompts and writes human-facing messages to stdout.
- ACP stdio uses stdin/stdout for newline-delimited JSON-RPC. The gateway must not run the terminal login wizard or write ordinary logs to stdout while ACP is connected.
- Create a dedicated ACP entry point that initializes the browser without starting the REST server or interactive terminal setup. Route application logs to stderr. Manual provider login should happen in the visible dedicated Chrome profile through an explicit setup flow; do not attempt to solve CAPTCHAs or bypass provider checks.

## Proposed new modules

```text
src/acp/
  index.js                  # stable ACP v1 stdio entry point
  agent.js                  # ACP lifecycle, provider sessions, tool loop and permissions
  helpers.js                # prompt/session/provider helpers
  toolProtocol.js           # strict JSON envelope parser and tool prompt builder
  toolExecutor.js           # workspace-scoped file and process tools
```

The exact split may change after the SDK and T3 handshake prototype. Avoid duplicating browser provider adapters or session logic.

## ACP protocol strategy

Use the official TypeScript ACP SDK rather than implementing JSON-RPC framing manually.

- Start with the stable ACP v1 handshake and Local ACP command in T3.
- T3 currently prefers ACP v2 preview but supports v1 fallback for agents that have not migrated. Add v2 only after the v1 round-trip is working and test both protocol versions against the actual T3 build.
- Advertise only capabilities actually implemented.
- Implement session creation, prompt turns, cancellation, session close/delete and stable v1 `session/load` history replay. A load restores the task transcript and starts a fresh provider conversation when the old browser session is unavailable.
- Use ACP `session/requestPermission` for file writes and terminal commands. An operation executes only when the exact offered `allow_once` option is selected; rejection, cancellation, unknown outcomes and request errors all fail closed.
- `read_file` is available by default and is constrained to the ACP session working directory. `write_file` is disabled by default and requires `BROWSER_AI_ENABLE_FILE_WRITES=1`. `run_command` is disabled by default and requires `BROWSER_AI_ENABLE_COMMANDS=1`.
- On cancellation, settle every outstanding permission request and report terminal status for every open tool call.

## Tool protocol and execution safety

A consumer website may return plain prose instead of a structured call. Never execute instructions inferred from arbitrary prose.

The model should be asked for a strict, versioned tool envelope, for example:

```json
{
  "protocol": "web-ai-tools/v1",
  "tool_calls": [
    {
      "id": "call-1",
      "tool": "read_file",
      "arguments": { "path": "src/index.js" }
    }
  ]
}
```

Required checks before dispatch:
- Validate the whole envelope and every tool's exact argument schema.
- Reject unknown tool names, extra arguments, duplicate IDs, oversized payloads and malformed JSON.
- Resolve paths relative to the ACP session cwd and reject traversal or symlink escapes outside the allowed workspace.
- Use narrow tools (read file, list/search, apply patch/write file, run command) with explicit argument limits.
- Never use shell string concatenation for structured commands; `run_command` uses argv-based process spawning with `shell: false`.
- Request permission before every file write and command operation.
- Important limitation: the command's working directory is the project workspace, but this is not an OS sandbox. An approved command can still access other host paths and resources using the gateway process's OS privileges. Keep command execution opt-in and use T3's Supervised permission mode when interactive approval is required.
- Treat rejection, cancellation, timeout or unknown permission outcomes as not approved.
- Keep an execution journal. Do not blindly retry a shell side effect after a crash; reconcile whether it ran first.

## Context and sessions

- ACP session ID is the T3-facing session identifier; browser session ID and provider conversation identity are separate internal IDs.
- Persist the ACP session ID, provider ID, cwd/workspace boundary, task transcript, complete replay event stream, handoff summary and whether a turn was active. Browser-session IDs are deliberately not treated as durable because provider tabs and hidden web conversations are not recoverable state.
- Use atomic JSON snapshots with restrictive local file permissions. The default state directory is `$XDG_STATE_HOME/browser-ai-bridge/acp` (or `~/.local/state/browser-ai-bridge/acp`); override it with `BROWSER_AI_ACP_STATE_DIR`.
- On `session/load`, verify the saved working directory, replay all stored ACP updates and rebuild provider context from the saved transcript. Never automatically replay an interrupted prompt or command.
- Reuse the same provider conversation across turns while it remains healthy.
- When context nears the provider's configured budget, compact the canonical task state, start a new website conversation and inject a verified handoff summary.
- On provider switch, transfer the canonical task summary and relevant project context. Do not claim the new provider can see another website's hidden chat history.
- Handle login expiry, provider rate limits, context exhaustion, browser crash, UI drift, workspace violations and cancellation as distinct states.

## Implementation milestones

1. **ACP transport and provider modes — implemented in source, not runtime-verified.** Stable ACP v1 stdio entry point, Local ACP command shape, provider choice through ACP session modes.
2. **Browser conversation mapping — implemented in source, not runtime-verified.** One browser provider session per ACP session; subsequent prompts reuse the same website conversation.
3. **Strict tool protocol — implemented in source, not runtime-verified.** Only a single fenced `web_ai_tools` JSON envelope is parsed. Plain text is final output; malformed or ambiguous envelopes execute nothing.
4. **Initial permission-gated executor — implemented in source, not runtime-verified.** `read_file` is workspace-scoped and enabled by default. `write_file` and argv-based `run_command` are opt-in environment capabilities and request ACP permission before execution.
5. **Validation and safety hardening — source implementation in place; runtime verification pending.** Unit tests now cover protocol validation, tool opt-in, path traversal, symlink/hard-link handling, session snapshot persistence, ACP history replay and interrupted-operation reconciliation. Run the suite and verify permission/cancel/restart behavior against T3.
6. **Durable session recovery — implemented in source, not runtime-verified.** Persist ACP session metadata, provider selection, workspace, task history and replayable ACP updates; advertise `loadSession`; restore with `session/load` and replay the conversation. Interrupted turns are not re-run. Pending permissions are marked not executed; operations that reached `in_progress` are marked outcome-unknown and require manual inspection. The exact browser tab/website conversation is not persisted.
7. **ACP v2 preview — not implemented.** T3 supports ACP v1 fallback; v2 support can follow once the v1 integration is live-tested.
8. **Provider expansion — not implemented.** Gemini, DeepSeek, Kimi and Qwen after ChatGPT passes the complete workflow.

## Acceptance test

- T3 launches this repository as a Local ACP command.
- ChatGPT Web sign-in is manual in a dedicated persistent browser profile.
- The same T3 ACP session continues the same browser conversation across turns.
- When enabled, T3 receives ACP permission requests for file writes and terminal commands.
- A denied or cancelled operation never executes.
- File paths are constrained to the session workspace. Terminal commands start in that workspace but are not OS-sandboxed; users must understand this risk before enabling command execution.
- Approved operations return actual results to the same provider conversation.
- Cancellation settles tool calls and stops what can safely be stopped.
- Restart recovery replays saved conversation events, never automatically repeats a prompt or shell side effect, and clearly flags uncertain in-progress operations.
- `session/delete` removes the persisted snapshot; `session/close` releases runtime browser resources while retaining the recoverable session record.
- Invalid tool output and unknown website UI fail closed.
- All non-protocol diagnostics go to stderr; stdout remains valid ACP NDJSON.

## Current state

- Fork verified: `Mohamed-faaris/browser-ai-bridge`.
- Working branch: `feat/acp-gateway`.
- Initial code audit completed for the browser, session manager, provider map, existing agent route and startup/login sequence.
- [x] Official `@agentclientprotocol/sdk` dependency added and locked at 2.9.1.
- [x] ACP v1 stdio agent committed; T3 can select a web provider through ACP session modes.
- [x] ACP session ↔ existing browser session mapping implemented in memory; same browser conversation is reused across turns.
- [x] Browser startup is lazy and avoids the interactive REST-server login wizard; users sign in manually in the launched Chrome window.
- [x] ACP process routes console and Pino diagnostics to stderr, keeping stdout for protocol frames.
- [x] Helper tests added for prompt parsing, provider filtering, defaults, handoff and cwd validation.
- [ ] ACP v2 preview negotiation not yet implemented; current agent uses stable ACP v1, which T3 documents as a supported fallback.
- [x] Strict `web-ai-tools/v1` envelope parser and bounded tool-result handoff added.
- [x] ACP `session/requestPermission` flow added for file writes and terminal commands; only the explicit `allow_once` response authorizes execution.
- [x] Workspace-scoped `read_file` and `write_file` checks added, including traversal, symlink and hard-link checks.
- [x] argv-based `run_command` added with timeout, output cap and cancellation handling; the tool is disabled by default and is not an OS sandbox.
- [x] File writes and commands require explicit gateway environment opt-in; read-only file access is enabled by default.
- [x] Durable ACP session snapshots are stored under a private local state directory with atomic file replacement; the directory can be set with `BROWSER_AI_ACP_STATE_DIR`.
- [x] ACP `session/load` is advertised and replays the saved user/agent/tool update history after restart.
- [x] A loaded session rebuilds provider context from its transcript instead of reusing a stale browser-session ID.
- [x] Interrupted turns are not automatically retried; pending permission requests are marked not executed, while in-progress tool calls are marked outcome-unknown for manual inspection.
- [x] ACP session close/delete handlers added.
- [x] Write-target preflight now runs before asking T3 for permission, and execution repeats the path checks after approval.
- [x] Task prompts are recorded before tool execution so provider switching can hand off an unfinished task.
- [x] Unit tests added for allow-once writes, denied writes, path traversal, symlink escape, hard-link rejection, protocol schema and bounded tool results.
- [ ] Tests, Prettier and live T3 handshake not run in this environment; a local clone could not be fetched because this environment could not resolve github.com.
- Existing `/api/agent` and mock `read_file` are explicitly not considered production-ready for coding execution.
