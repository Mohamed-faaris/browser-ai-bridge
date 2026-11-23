# ACP Gateway Integration Plan

Status: implementation branch created; source audit in progress. This document is the gateway implementation plan, not a claim that ACP support is already implemented.

## Selected architecture

Run this repository as a standalone local ACP agent launched by T3 Code through **Settings → Providers → Add provider → Local ACP command**.

- T3 remains the coding UI and mediates ACP permission requests.
- This gateway owns browser-backed model sessions and local coding-tool execution.
- Each ACP session maps to a project working directory, selected web provider, browser conversation/session and durable gateway task state.
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
  index.js                 # stdio entry point; stdout reserved for ACP NDJSON
  agent-v1.js               # stable ACP v1 server handlers
  agent-v2.js               # ACP v2 preview handlers (after v1 handshake works)
  sessions.js               # ACP session ↔ browser session mapping
  context.js                # project/task context and handoff state
  tool-protocol.js          # strict JSON envelope parsing and schema validation
  tool-executor.js          # workspace-scoped file and process tools
  permissions.js            # ACP requestPermission round-trip
  persistence.js            # durable session/task/request state
```

The exact split may change after the SDK and T3 handshake prototype. Avoid duplicating browser provider adapters or session logic.

## ACP protocol strategy

Use the official TypeScript ACP SDK rather than implementing JSON-RPC framing manually.

- Start with the stable ACP v1 handshake and Local ACP command in T3.
- T3 currently prefers ACP v2 preview but supports v1 fallback for agents that have not migrated. Add v2 only after the v1 round-trip is working and test both protocol versions against the actual T3 build.
- Advertise only capabilities actually implemented.
- Implement session creation, prompt turns, cancellation, session close and, later, durable session resume/history replay.
- Use ACP `session/requestPermission` for all file mutations and command execution. An operation executes only when the exact offered allow option is selected.
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
- Never use shell string concatenation for structured commands; use argv-based process spawning where practical.
- Request permission before every mutation and command operation, according to the operation's risk class.
- Treat rejection, cancellation, timeout or unknown permission outcomes as not approved.
- Keep an execution journal. Do not blindly retry a shell side effect after a crash; reconcile whether it ran first.

## Context and sessions

- ACP session ID is the T3-facing session identifier; browser session ID and provider conversation identity are separate internal IDs.
- Persist provider ID, browser session mapping, cwd/workspace boundary, task transcript, recent tool events, handoff summary, prompt idempotency key and current generation.
- Reuse the same provider conversation across turns while it remains healthy.
- When context nears the provider's configured budget, compact the canonical task state, start a new website conversation and inject a verified handoff summary.
- On provider switch, transfer the canonical task summary and relevant project context. Do not claim the new provider can see another website's hidden chat history.
- Handle login expiry, provider rate limits, context exhaustion, browser crash, UI drift, workspace violations and cancellation as distinct states.

## First milestones

1. **ACP transport proof:** stable v1 Local ACP command starts, initializes and creates a session in T3 without touching the browser.
2. **Browser proof:** a ChatGPT-backed ACP session creates one browser conversation, prompts it and continues the same conversation for a second turn.
3. **Permission proof:** a synthetic tool call appears in T3, receives an ACP permission decision and correctly handles allow, reject and cancel. No local execution in this milestone.
4. **Safe executor:** add workspace-scoped `read_file`, patch/write and argv-based `run_command`, each with validated schemas and permission requests.
5. **Durability:** persist ACP/browser session mapping, request idempotency and tool execution journal; test process restart and uncertain side effects.
6. **Provider expansion:** Gemini, DeepSeek, Kimi and Qwen after ChatGPT passes the complete workflow.

## Acceptance test

- T3 launches this repository as a Local ACP command.
- ChatGPT Web sign-in is manual in a dedicated persistent browser profile.
- The same T3 ACP session continues the same browser conversation across turns.
- T3 displays ACP permission requests for file writes and terminal commands.
- A denied operation never executes.
- Approved operations are constrained to the session workspace and return actual results to the same provider conversation.
- Cancellation settles tool calls and stops what can safely be stopped.
- Restart recovery never blindly repeats an uncertain shell side effect.
- Invalid tool output and unknown website UI fail closed.
- All non-protocol diagnostics go to stderr; stdout remains valid ACP NDJSON.

## Current state

- Fork verified: `Mohamed-faaris/browser-ai-bridge`.
- Working branch: `feat/acp-gateway`.
- Initial code audit completed for the browser, session manager, provider map, existing agent route and startup/login sequence.
- No ACP SDK or gateway implementation has been committed yet.
- Existing `/api/agent` and mock `read_file` are explicitly not considered production-ready for coding execution.
