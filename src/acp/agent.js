import path from "node:path";
import { randomUUID } from "node:crypto";
import { AcpSessionStore } from "./sessionStore.js";
import {
  buildHandoffPrompt,
  listProviderModes,
  parsePromptText,
  resolveDefaultProvider,
  validateWorkingDirectory,
} from "./helpers.js";
import {
  buildCodingPrompt,
  formatWebToolResults,
  parseWebToolResponse,
  resolveEnabledTools,
} from "./toolProtocol.js";
import { executeWorkspaceTool, validateWorkspaceToolTarget } from "./toolExecutor.js";

const AGENT_NAME = "Browser AI Bridge";
const AGENT_VERSION = "0.2.0";
const MAX_TOOL_ROUNDS = 8;

export class BrowserAiAcpAgent {
  constructor({
    acp,
    connectToBrowser,
    sessionManager,
    providerConfig,
    providerFilter = process.env.BROWSER_AI_PROVIDERS,
    defaultProvider = process.env.BROWSER_AI_PROVIDER || "chatgpt",
    sessionStore = new AcpSessionStore(),
  }) {
    this.acp = acp;
    this.connectToBrowser = connectToBrowser;
    this.sessionManager = sessionManager;
    this.sessionStore = sessionStore;
    this.providerConfig = providerConfig;
    this.providerModes = listProviderModes(providerConfig, providerFilter);
    this.enabledTools = resolveEnabledTools();
    this.defaultProvider = resolveDefaultProvider(this.providerModes, defaultProvider);
    this.sessions = new Map();
    this.browserReady = null;
    this.shuttingDown = false;
  }

  initialize() {
    return {
      protocolVersion: this.acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
    };
  }

  async newSession(params) {
    const cwd = validateWorkingDirectory(params.cwd);
    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      cwd,
      providerId: this.defaultProvider,
      providerSessionId: null,
      turnNumber: 0,
      activeTurn: null,
      turnInProgress: false,
      history: [],
      events: [],
      pendingHandoff: null,
      createdAt: Date.now(),
      deleted: false,
    };
    await this.persistSession(session);
    this.sessions.set(sessionId, session);
    return {
      sessionId,
      modes: {
        currentModeId: this.defaultProvider,
        availableModes: this.providerModes,
      },
    };
  }

  async persistSession(session) {
    if (!session || session.deleted || !this.sessionStore) return;
    await this.sessionStore.save({
      id: session.id,
      cwd: session.cwd,
      providerId: session.providerId,
      turnNumber: session.turnNumber,
      history: session.history,
      pendingHandoff: session.pendingHandoff,
      events: session.events || [],
      turnInProgress: session.turnInProgress === true || Boolean(session.activeTurn),
      createdAt: session.createdAt,
    });
  }

  async loadSession(params, client) {
    const sessionId = String(params.sessionId || "");
    let session = this.sessions.get(sessionId);
    if (!session) {
      const stored = await this.sessionStore.load(sessionId);
      if (!stored) throw this.acp.RequestError.sessionNotFound(sessionId);
      const requestedCwd = validateWorkingDirectory(params.cwd);
      if (path.resolve(stored.cwd) !== requestedCwd) {
        throw this.acp.RequestError.invalidParams(
          { sessionId, cwd: params.cwd },
          "The requested working directory does not match the persisted ACP session.",
        );
      }
      if (!this.providerModes.some((mode) => mode.id === stored.providerId)) {
        throw this.acp.RequestError.invalidParams(
          { sessionId, providerId: stored.providerId },
          "The provider used by this saved session is not enabled. Re-enable it in BROWSER_AI_PROVIDERS and retry.",
        );
      }
      session = {
        ...stored,
        providerSessionId: null,
        activeTurn: null,
        turnInProgress: stored.turnInProgress === true,
        events: Array.isArray(stored.events) ? stored.events : [],
        deleted: false,
      };
      this.sessions.set(sessionId, session);
    } else {
      const requestedCwd = validateWorkingDirectory(params.cwd);
      if (requestedCwd !== path.resolve(session.cwd)) {
        throw this.acp.RequestError.invalidParams(
          { sessionId, cwd: params.cwd },
          "The requested working directory does not match the active ACP session.",
        );
      }
    }

    if (session.activeTurn) {
      throw this.acp.RequestError.invalidParams(
        { sessionId },
        "Cannot load an ACP session while one of its turns is running.",
      );
    }

    // Browser/provider tabs are process-local. Recover the task from the
    // transcript and create a new provider conversation on the next prompt.
    if (!session.providerSessionId && session.history.length && !session.pendingHandoff) {
      session.pendingHandoff = buildHandoffPrompt(
        session.history,
        session.providerId,
        session.providerId,
      );
    }

    if (session.turnInProgress) {
      this.reconcileInterruptedToolCalls(session);
      const recoveryNotice =
        "The gateway restarted while the previous turn was active. That turn was not resumed automatically. Any tool call that had reached in_progress has an unknown outcome; inspect its effects before retrying. Pending permission requests were not executed.";
      session.history.push({ role: "assistant", content: recoveryNotice });
      this.trimHistory(session);
      session.events.push({
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: recoveryNotice },
      });
      session.turnInProgress = false;
    }

    await this.persistSession(session);
    for (const update of session.events) {
      await client.notify(this.acp.methods.client.session.update, {
        sessionId,
        update,
      });
    }
    return {
      modes: {
        currentModeId: session.providerId,
        availableModes: this.providerModes,
      },
    };
  }

  reconcileInterruptedToolCalls(session) {
    const latest = new Map();
    for (const update of session.events) {
      if (update?.sessionUpdate === "tool_call" && update.toolCallId) {
        latest.set(update.toolCallId, { status: update.status, name: update.name });
      } else if (update?.sessionUpdate === "tool_call_update" && update.toolCallId) {
        const previous = latest.get(update.toolCallId) || {};
        latest.set(update.toolCallId, { ...previous, status: update.status });
      }
    }
    for (const [toolCallId, tool] of latest) {
      if (tool.status !== "pending" && tool.status !== "in_progress") continue;
      const uncertain = tool.status === "in_progress";
      const output = uncertain
        ? "The gateway restarted while this operation was in progress. Its outcome is unknown; inspect the workspace and running processes before retrying. The gateway did not retry it."
        : "The gateway restarted before this operation was approved for execution. It was not executed.";
      session.events.push({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{
          type: "content",
          content: { type: "text", text: output },
        }],
        rawOutput: {
          status: "interrupted",
          outcome: uncertain ? "unknown" : "not_executed",
          output,
          tool: tool.name || "unknown",
        },
      });
    }
  }

  authenticate() {
    // Website authentication is performed manually in the dedicated Chrome profile.
    return {};
  }

  async setSessionMode(params) {
    const session = this.requireSession(params.sessionId);
    const nextProvider = String(params.modeId || "").toLowerCase();

    if (!this.providerModes.some((mode) => mode.id === nextProvider)) {
      throw this.acp.RequestError.invalidParams(
        { modeId: params.modeId },
        `Unknown or disabled web provider: ${params.modeId}`,
      );
    }
    if (session.activeTurn) {
      throw this.acp.RequestError.invalidParams(
        { sessionId: session.id },
        "Cannot switch web providers while a turn is running.",
      );
    }
    if (nextProvider === session.providerId) return {};

    const previousProvider = session.providerId;
    session.pendingHandoff = buildHandoffPrompt(session.history, previousProvider, nextProvider);
    await this.releaseProviderSession(session);
    session.providerId = nextProvider;
    await this.persistSession(session);
    return {};
  }

  async prompt(params, client) {
    const session = this.requireSession(params.sessionId);
    if (session.activeTurn) {
      throw this.acp.RequestError.invalidParams(
        { sessionId: session.id },
        "This ACP session already has an active turn.",
      );
    }

    let userPrompt;
    try {
      userPrompt = parsePromptText(params.prompt);
    } catch (error) {
      throw this.acp.RequestError.invalidParams({ sessionId: session.id }, error.message);
    }

    const provider = this.providerConfig[session.providerId];
    const maxPromptChars = Number(provider?.maxPromptChars || 0);
    if (maxPromptChars > 0 && userPrompt.length > maxPromptChars - 2500) {
      throw this.acp.RequestError.invalidParams(
        { length: userPrompt.length, maxPromptChars },
        `${provider.name} requires space for the gateway instructions; keep the task below ${Math.max(0, maxPromptChars - 2500)} characters.`,
      );
    }

    const activeTurn = { cancelled: false, controller: new AbortController() };
    session.activeTurn = activeTurn;
    session.turnInProgress = true;
    session.turnNumber += 1;
    session.history.push({ role: "user", content: userPrompt });
    session.events.push({
      sessionUpdate: "user_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text: userPrompt },
    });
    this.trimHistory(session);

    let providerSession = null;
    try {
      await this.persistSession(session);
      providerSession = await this.ensureProviderSession(session);
      providerSession.locked = true;
      providerSession.lockedAt = Date.now();
      providerSession.clientGone = false;

      let outboundPrompt = buildCodingPrompt(session.cwd, userPrompt, this.enabledTools);
      if (session.pendingHandoff) {
        const handoffBudget = maxPromptChars > 0 ? Math.max(0, maxPromptChars - outboundPrompt.length - 2) : 6000;
        outboundPrompt = `${session.pendingHandoff.slice(0, handoffBudget)}\n\n${outboundPrompt}`;
      }

      for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (activeTurn.cancelled || activeTurn.controller.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        const response = await providerSession.engine.sendPromptAndWait(
          outboundPrompt,
          `ACP turn ${session.turnNumber} / model round ${round}`,
        );

        if (!response?.ok) {
          const failureText = this.describeProviderFailure(session.providerId, response);
          await this.sendAssistantText(client, session.id, failureText);
          return { stopReason: "end_turn" };
        }

        let parsed;
        try {
          parsed = parseWebToolResponse(response.text, { enabledTools: this.enabledTools });
        } catch (error) {
          const protocolError =
            `I stopped because the model returned an invalid or ambiguous tool protocol. No requested tool was executed. Details: ${error.message}`;
          await this.sendAssistantText(client, session.id, protocolError);
          session.history.push({ role: "assistant", content: protocolError });
          await this.persistSession(session);
          return { stopReason: "end_turn" };
        }

        if (parsed.type === "final") {
          const finalText = parsed.text || "(The provider returned an empty response.)";
          await this.sendAssistantText(client, session.id, finalText);
          session.history.push({ role: "assistant", content: finalText });
          this.trimHistory(session);
          session.pendingHandoff = null;
          await this.persistSession(session);
          return { stopReason: "end_turn" };
        }

        const results = [];
        for (const call of parsed.calls) {
          if (activeTurn.cancelled || activeTurn.controller.signal.aborted) {
            return { stopReason: "cancelled" };
          }
          const result = await this.runToolCall(session, client, call, activeTurn);
          results.push(result);
        }

        session.history.push({
          role: "assistant",
          content: JSON.stringify({ tool_calls: parsed.calls.map(({ id, tool, arguments: args }) => ({ id, tool, arguments: args })) }),
        });
        session.history.push({
          role: "assistant",
          content: JSON.stringify({ tool_results: results }),
        });
        this.trimHistory(session);
        await this.persistSession(session);
        outboundPrompt = formatWebToolResults(
          results,
          maxPromptChars > 0 ? Math.max(2000, maxPromptChars - 2500) : 60000,
        );
      }

      const limitMessage = `Stopped after ${MAX_TOOL_ROUNDS} tool rounds to avoid an unbounded autonomous loop. Review the tool results and send a follow-up to continue.`;
      await this.sendAssistantText(client, session.id, limitMessage);
      session.history.push({ role: "assistant", content: limitMessage });
      this.trimHistory(session);
      return { stopReason: "end_turn" };
    } catch (error) {
      if (activeTurn.cancelled || activeTurn.controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      const message = `Browser AI Gateway error: ${error?.message || String(error)}`;
      await this.sendAssistantText(client, session.id, message).catch(() => {});
      session.history.push({ role: "assistant", content: message });
      await this.persistSession(session).catch(() => {});
      return { stopReason: "end_turn" };
    } finally {
      if (providerSession) {
        providerSession.locked = false;
        providerSession.lockedAt = null;
      }
      if (session.activeTurn === activeTurn) session.activeTurn = null;
      session.turnInProgress = false;
      await this.persistSession(session).catch((error) => {
        console.error("[ACP] Could not persist completed turn: " + (error?.message || error));
      });
    }
  }

  async runToolCall(session, client, call, activeTurn) {
    const toolCallId = randomUUID();
    const mutating = call.tool === "write_file" || call.tool === "run_command";
    const kind = call.tool === "read_file" ? "read" : call.tool === "write_file" ? "edit" : "execute";
    const title = call.tool === "read_file"
      ? `Read ${call.arguments.path}`
      : call.tool === "write_file"
        ? `Write ${call.arguments.path}`
        : `Run ${call.arguments.command}`;
    const locations = call.tool === "run_command"
      ? []
      : [{ path: path.resolve(session.cwd, call.arguments.path) }];
    const rawInput = {
      tool: call.tool,
      arguments: call.arguments,
      workingDirectory: session.cwd,
    };

    await this.updateToolCall(client, session.id, {
      sessionUpdate: "tool_call",
      toolCallId,
      name: call.tool,
      title,
      kind,
      status: "pending",
      locations,
      rawInput,
    });

    // Validate write targets before presenting the permission request. This is
    // preflight only; executeWorkspaceTool repeats all checks immediately before
    // the actual write to limit path-race exposure.
    if (call.tool === "write_file") {
      try {
        await validateWorkspaceToolTarget(call, session.cwd);
      } catch (error) {
        const failed = {
          id: call.id,
          tool: call.tool,
          status: "failed",
          output: error?.message || String(error),
        };
        await this.updateToolCall(client, session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: failed,
        });
        return failed;
      }
    }

    if (mutating) {
      try {
        const permission = await client.request(
          this.acp.methods.client.session.requestPermission,
          {
            sessionId: session.id,
            toolCall: {
              toolCallId,
              name: call.tool,
              title,
              kind,
              status: "pending",
              locations,
              rawInput,
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
          {
            cancellationSignal: activeTurn.controller.signal,
            stopWaitingOnCancel: true,
          },
        );

        const allowed =
          permission?.outcome?.outcome === "selected" &&
          permission.outcome.optionId === "allow_once";

        if (!allowed) {
          const denied = {
            id: call.id,
            tool: call.tool,
            status: "denied",
            output: "The user did not approve this operation. It was not executed.",
          };
          await this.updateToolCall(client, session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            rawOutput: denied,
          });
          return denied;
        }
      } catch (error) {
        const cancelled = activeTurn.controller.signal.aborted;
        const failed = {
          id: call.id,
          tool: call.tool,
          status: cancelled ? "cancelled" : "permission_error",
          output: cancelled
            ? "The permission request was cancelled. The operation was not executed."
            : `Permission request failed: ${error?.message || String(error)}. The operation was not executed.`,
        };
        await this.updateToolCall(client, session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: failed,
        }).catch(() => {});
        return failed;
      }
    }

    if (activeTurn.controller.signal.aborted) {
      const cancelled = {
        id: call.id,
        tool: call.tool,
        status: "cancelled",
        output: "The operation was cancelled before execution.",
      };
      await this.updateToolCall(client, session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: cancelled,
      }).catch(() => {});
      return cancelled;
    }

    await this.updateToolCall(client, session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
    });

    try {
      const value = await executeWorkspaceTool(call, session.cwd, activeTurn.controller.signal);
      const completed = {
        id: call.id,
        tool: call.tool,
        status:
          value?.status === "completed"
            ? "completed"
            : value?.status === "timeout"
              ? "timeout"
              : "cancelled",
        output: JSON.stringify(value),
      };
      await this.updateToolCall(client, session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: completed.status === "completed" ? "completed" : "failed",
        content: [{
          type: "content",
          content: { type: "text", text: completed.output.slice(0, 16000) },
        }],
        rawOutput: completed,
      });
      return completed;
    } catch (error) {
      const failed = {
        id: call.id,
        tool: call.tool,
        status: "failed",
        output: error?.message || String(error),
      };
      await this.updateToolCall(client, session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{
          type: "content",
          content: { type: "text", text: failed.output },
        }],
        rawOutput: failed,
      });
      return failed;
    }
  }

  async updateToolCall(client, sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.events.push(JSON.parse(JSON.stringify(update)));
      await this.persistSession(session);
    }
    return client.notify(this.acp.methods.client.session.update, {
      sessionId,
      update,
    });
  }

  async sendAssistantText(client, sessionId, text) {
    const update = {
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text: String(text || "") },
    };
    const session = this.sessions.get(sessionId);
    if (session) {
      session.events.push(update);
      await this.persistSession(session);
    }
    return client.notify(this.acp.methods.client.session.update, {
      sessionId,
      update,
    });
  }

  trimHistory(session) {
    if (session.history.length > 24) {
      session.history.splice(0, session.history.length - 24);
    }
  }

  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activeTurn) return;

    session.activeTurn.cancelled = true;
    session.activeTurn.controller.abort(new Error("ACP session cancelled."));
    // Force-close the browser page so a provider generation cannot be recycled
    // into another session while its previous turn is still active.
    await this.releaseProviderSession(session, { forceClose: true });
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw this.acp.RequestError.sessionNotFound(sessionId);
    return session;
  }

  async ensureBrowser() {
    if (this.shuttingDown) throw new Error("The ACP gateway is shutting down.");
    if (!this.browserReady) {
      this.browserReady = this.connectToBrowser().catch((error) => {
        this.browserReady = null;
        throw error;
      });
    }
    await this.browserReady;
  }

  async ensureProviderSession(session) {
    await this.ensureBrowser();

    let providerSession = session.providerSessionId
      ? this.sessionManager.getSession(session.providerSessionId)
      : null;

    if (!providerSession) {
      if (session.providerSessionId) {
        session.providerSessionId = null;
        if (session.history.length && !session.pendingHandoff) {
          session.pendingHandoff = buildHandoffPrompt(
            session.history,
            session.providerId,
            session.providerId,
          );
        }
      }
      session.providerSessionId = await this.sessionManager.createSession(session.providerId);
      providerSession = this.sessionManager.getSession(session.providerSessionId);
    }

    if (!providerSession) {
      throw new Error("The browser provider session could not be created or recovered.");
    }
    return providerSession;
  }

  async releaseProviderSession(session, { forceClose = false } = {}) {
    const providerSessionId = session.providerSessionId;
    session.providerSessionId = null;
    if (!providerSessionId) return;

    if (forceClose) {
      const providerSession = this.sessionManager.getSession(providerSessionId);
      if (providerSession?.engine?.close) {
        await providerSession.engine.close().catch(() => {});
      }
    }
    await this.sessionManager.closeSession(providerSessionId).catch(() => {});
  }

  describeProviderFailure(providerId, result) {
    const providerName = this.providerConfig[providerId]?.name || providerId;
    if (result?.signedOut) {
      return `${providerName} is not signed in. Sign in manually in the Chrome window opened by the gateway, then retry this turn.`;
    }
    if (result?.rateLimited) {
      return `${providerName} reported a usage or rate limit. Wait for the provider's retry window or select another provider using the ACP session mode.`;
    }
    return result?.reason
      ? `${providerName} could not complete the request: ${result.reason}`
      : `${providerName} did not return a successful response.`;
  }

  async closeSession(params) {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      if (session.activeTurn) {
        session.activeTurn.cancelled = true;
        session.activeTurn.controller.abort(new Error("ACP session closed."));
      }
      await this.persistSession(session);
      await this.releaseProviderSession(session, { forceClose: true });
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  async deleteSession(params) {
    const session = this.sessions.get(params.sessionId);
    if (session) session.deleted = true;
    await this.closeSession(params);
    await this.sessionStore.delete(params.sessionId);
    return {};
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const session of this.sessions.values()) {
      await this.persistSession(session).catch((error) => {
        console.error("[ACP] Could not persist session during shutdown: " + (error?.message || error));
      });
      if (session.activeTurn) {
        session.activeTurn.cancelled = true;
        session.activeTurn.controller.abort(new Error("ACP gateway shutting down."));
      }
      await this.releaseProviderSession(session, { forceClose: true });
    }
    this.sessions.clear();
    await this.sessionManager.closeAllSessions().catch(() => {});
  }
}
