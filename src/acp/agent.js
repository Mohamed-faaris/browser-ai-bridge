import { randomUUID } from "node:crypto";
import {
  buildHandoffPrompt,
  listProviderModes,
  parsePromptText,
  resolveDefaultProvider,
  validateWorkingDirectory,
} from "./helpers.js";

const AGENT_NAME = "Browser AI Bridge";
const AGENT_VERSION = "0.1.0";

export class BrowserAiAcpAgent {
  constructor({
    acp,
    connectToBrowser,
    sessionManager,
    providerConfig,
    providerFilter = process.env.BROWSER_AI_PROVIDERS,
    defaultProvider = process.env.BROWSER_AI_PROVIDER || "chatgpt",
  }) {
    this.acp = acp;
    this.connectToBrowser = connectToBrowser;
    this.sessionManager = sessionManager;
    this.providerConfig = providerConfig;
    this.providerModes = listProviderModes(providerConfig, providerFilter);
    this.defaultProvider = resolveDefaultProvider(
      this.providerModes,
      defaultProvider,
    );
    this.sessions = new Map();
    this.browserReady = null;
    this.shuttingDown = false;
  }

  initialize() {
    return {
      protocolVersion: this.acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
    };
  }

  newSession(params) {
    const cwd = validateWorkingDirectory(params.cwd);
    const sessionId = randomUUID();

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      providerId: this.defaultProvider,
      providerSessionId: null,
      turnNumber: 0,
      activeTurn: null,
      history: [],
      pendingHandoff: null,
    });

    return {
      sessionId,
      modes: {
        currentModeId: this.defaultProvider,
        availableModes: this.providerModes,
      },
    };
  }

  authenticate() {
    // Provider website login is performed manually in the persistent Chrome profile.
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
    session.pendingHandoff = buildHandoffPrompt(
      session.history,
      previousProvider,
      nextProvider,
    );
    await this.releaseProviderSession(session);
    session.providerId = nextProvider;
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
      throw this.acp.RequestError.invalidParams(
        { sessionId: session.id },
        error.message,
      );
    }

    const provider = this.providerConfig[session.providerId];
    const maxPromptChars = Number(provider?.maxPromptChars || 0);
    if (maxPromptChars > 0 && userPrompt.length > maxPromptChars) {
      throw this.acp.RequestError.invalidParams(
        { length: userPrompt.length, maxPromptChars },
        `${provider.name} accepts at most ${maxPromptChars} characters per prompt.`,
      );
    }

    const activeTurn = { cancelled: false };
    session.activeTurn = activeTurn;
    session.turnNumber += 1;

    let providerSession = null;
    try {
      providerSession = await this.ensureProviderSession(session);
      providerSession.locked = true;
      providerSession.lockedAt = Date.now();
      providerSession.clientGone = false;

      let outboundPrompt = userPrompt;
      if (session.pendingHandoff) {
        const handoffBudget = Math.max(
          0,
          maxPromptChars > 0 ? maxPromptChars - userPrompt.length - 2 : 6000,
        );
        outboundPrompt = `${session.pendingHandoff.slice(0, handoffBudget)}\n\n${userPrompt}`;
      }

      const result = await providerSession.engine.sendPromptAndWait(
        outboundPrompt,
        `ACP turn ${session.turnNumber}`,
        providerSession.id,
      );

      if (activeTurn.cancelled) return { stopReason: "cancelled" };

      const assistantText = result?.ok
        ? String(result.text || "")
        : this.describeProviderFailure(session.providerId, result);

      if (result?.ok) {
        session.history.push({ role: "user", content: userPrompt });
        session.history.push({ role: "assistant", content: assistantText });
        // Keep a bounded handoff transcript; the website conversation itself remains
        // the primary context while the provider session is healthy.
        if (session.history.length > 16) {
          session.history.splice(0, session.history.length - 16);
        }
        session.pendingHandoff = null;
      }

      await client.notify(this.acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: assistantText || "(The provider returned an empty response.)" },
        },
      });

      return { stopReason: result?.ok ? "end_turn" : "refusal" };
    } catch (error) {
      if (activeTurn.cancelled) return { stopReason: "cancelled" };

      const message = `Browser AI Gateway error: ${error?.message || String(error)}`;
      await client
        .notify(this.acp.methods.client.session.update, {
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: message },
          },
        })
        .catch(() => {});
      return { stopReason: "refusal" };
    } finally {
      if (providerSession) {
        providerSession.locked = false;
        providerSession.lockedAt = null;
      }
      if (session.activeTurn === activeTurn) session.activeTurn = null;
    }
  }

  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activeTurn) return;

    session.activeTurn.cancelled = true;
    // Closing the provider tab is the conservative cancellation mechanism available
    // in the existing browser engine. The next ACP turn creates a fresh browser
    // session instead of risking reuse of a page still generating.
    await this.releaseProviderSession(session);
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw this.acp.RequestError.sessionNotFound(sessionId);
    return session;
  }

  async ensureBrowser() {
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
      session.providerSessionId = await this.sessionManager.createSession(
        session.providerId,
      );
      providerSession = this.sessionManager.getSession(session.providerSessionId);
    }

    if (!providerSession) {
      throw new Error("The browser provider session could not be created or recovered.");
    }
    return providerSession;
  }

  async releaseProviderSession(session) {
    const providerSessionId = session.providerSessionId;
    session.providerSessionId = null;
    if (providerSessionId) {
      await this.sessionManager.closeSession(providerSessionId).catch(() => {});
    }
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

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const session of this.sessions.values()) {
      session.activeTurn && (session.activeTurn.cancelled = true);
      await this.releaseProviderSession(session);
    }
    this.sessions.clear();
    await this.sessionManager.closeAllSessions().catch(() => {});
  }
}
