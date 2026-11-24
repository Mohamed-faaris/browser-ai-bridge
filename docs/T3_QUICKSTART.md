# Quick start with T3 Code

## Requirements

- Node.js 20 or later.
- Chrome/Chromium available on the T3 server host.
- A browser account for whichever consumer AI website you select.
- This gateway running on the same host/environment as T3 Code so its local tools operate on the intended project filesystem.

## Install and register

From a local checkout of this fork:

```bash
git clone https://github.com/Mohamed-faaris/browser-ai-bridge.git
cd browser-ai-bridge
git switch feat/acp-gateway
npm ci
```

In T3 Code, open **Settings → Providers → Add provider → Show more → Local ACP command** and configure:

- **Executable:** `node`
- **Arguments:** `/absolute/path/to/browser-ai-bridge/src/acp/index.js`
- **Environment overrides:** set `BROWSER_AI_PROVIDER=chatgpt` if you want ChatGPT as the initial provider. Use `BROWSER_AI_PROVIDERS=chatgpt,gemini,deepseek` to restrict the providers offered in the model/mode picker.

The ACP entry point does not start the REST API server or the interactive login wizard. It also does not automatically load `.env`; supply environment variables in the T3 Local ACP command's **Environment overrides**. The `.env.example` file is documentation only unless you explicitly load it in your launch command.

ACP session snapshots are persisted automatically. The default directory is `$XDG_STATE_HOME/browser-ai-bridge/acp` (normally `~/.local/state/browser-ai-bridge/acp`). Set `BROWSER_AI_ACP_STATE_DIR` to choose another local directory. Keep this directory private: it contains prompts, assistant responses and tool-call details.

## First run

1. Start a new T3 thread and select the Browser AI Bridge ACP provider.
2. Send a simple text-only prompt. The gateway lazily starts/attaches to Chrome and opens the selected provider website.
3. If the website is signed out, sign in manually in the visible Chrome window and retry the prompt. Do not attempt CAPTCHA solving or account-limit bypasses.
4. Start with read-only file access. `read_file` is enabled by default and is restricted to the thread's absolute working directory.
5. Only after you understand the execution boundary, enable optional write/command tools using T3's Environment overrides:
   - `BROWSER_AI_ENABLE_FILE_WRITES=1`
   - `BROWSER_AI_ENABLE_COMMANDS=1`

Keep T3's thread permission mode at **Supervised** while testing. Every write and command sends an ACP permission request, and only `allow_once` executes. T3 can also auto-approve according to the thread permission mode; Full access should not be used until the gateway has been validated thoroughly.

## Current MVP limitations

- Stable ACP v1 only. T3 documents v1 fallback support; ACP v2 preview is not implemented.
- Text prompt blocks only. Image, audio and resource attachments are rejected clearly instead of silently ignored.
- ACP session metadata, task history and replayable updates are persisted locally and restored through ACP `session/load`. A gateway restart does **not** restore the exact Chrome tab or hidden website conversation; the gateway creates a new provider conversation and injects a handoff from saved history.
- An interrupted turn is never automatically re-run. Pending permission requests are recorded as not executed. Tool calls that had reached `in_progress` are restored as outcome-unknown; inspect the workspace/process state before retrying.
- Provider output is collected by the existing browser bridge before the ACP message is sent; true incremental token streaming is not implemented.
- Only `read_file`, `write_file` and `run_command` are in the new coding tool protocol.
- `write_file` and `run_command` are disabled by default.
- `run_command` uses argv with `shell:false`, but it is **not an OS sandbox**. An approved executable can still access host resources and environment variables available to the gateway process. It runs with the gateway user's OS permissions. Enable it only when trusted and with T3 Supervised approvals.
- File reads/writes reject path traversal, symlink escapes and files with multiple hard links. These checks reduce common path escapes but do not turn a normal process into a hardened OS sandbox.
- Durable state uses atomic JSON snapshots with restrictive file permissions. The current snapshot limit is 12 MiB per session; large transcripts fail to persist instead of being silently truncated.
- No local tests or live T3 handshake have been run from this environment yet.

---

