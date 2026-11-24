import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserAiAcpAgent } from "../../src/acp/agent.js";
import { AcpSessionStore } from "../../src/acp/sessionStore.js";

function makeAgent({ sessionStore } = {}) {
  const acp = {
    methods: {
      client: {
        session: {
          requestPermission: "session/request_permission",
          update: "session/update",
        },
      },
    },
  };
  const agent = new BrowserAiAcpAgent({
    acp,
    connectToBrowser: async () => ({}),
    sessionManager: {},
    providerConfig: {
      chatgpt: { name: "ChatGPT", maxPromptChars: 150000 },
    },
    defaultProvider: "chatgpt",
    ...(sessionStore ? { sessionStore } : {}),
  });
  return { agent, acp };
}

function makeClient({ permission = { outcome: { outcome: "selected", optionId: "allow_once" } } } = {}) {
  const notifications = [];
  const requests = [];
  return {
    notifications,
    requests,
    async notify(method, params) {
      notifications.push({ method, params });
    },
    async request(method, params) {
      requests.push({ method, params });
      return permission;
    },
  };
}

test("write_file executes only after an explicit allow_once ACP permission", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-agent-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const { agent } = makeAgent();
  const client = makeClient();
  const session = { id: "session-1", cwd };
  const activeTurn = { controller: new AbortController(), cancelled: false };

  const result = await agent.runToolCall(
    session,
    client,
    {
      id: "tool-1",
      tool: "write_file",
      arguments: { path: "created.txt", content: "approved" },
    },
    activeTurn,
  );

  assert.equal(result.status, "completed");
  assert.equal(await fs.readFile(path.join(cwd, "created.txt"), "utf8"), "approved");
  assert.equal(client.requests.length, 1);
  assert.equal(
    client.requests[0].params.options.some((option) => option.optionId === "allow_once"),
    true,
  );
  assert.equal(
    client.notifications.some((entry) => entry.params.update.sessionUpdate === "tool_call"),
    true,
  );
});

test("rejected write_file never creates the target file", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-agent-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const { agent } = makeAgent();
  const client = makeClient({
    permission: { outcome: { outcome: "selected", optionId: "reject_once" } },
  });
  const session = { id: "session-2", cwd };
  const activeTurn = { controller: new AbortController(), cancelled: false };

  const result = await agent.runToolCall(
    session,
    client,
    {
      id: "tool-2",
      tool: "write_file",
      arguments: { path: "rejected.txt", content: "must not exist" },
    },
    activeTurn,
  );

  assert.equal(result.status, "denied");
  await assert.rejects(fs.access(path.join(cwd, "rejected.txt")));
  assert.equal(client.requests.length, 1);
});

test("write_file outside the workspace is rejected before asking permission", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-agent-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const cwd = path.join(parent, "project");
  await fs.mkdir(cwd);

  const { agent } = makeAgent();
  const client = makeClient();
  const session = { id: "session-3", cwd };
  const activeTurn = { controller: new AbortController(), cancelled: false };

  const result = await agent.runToolCall(
    session,
    client,
    {
      id: "tool-3",
      tool: "write_file",
      arguments: { path: "../outside.txt", content: "must not exist" },
    },
    activeTurn,
  );

  assert.equal(result.status, "failed");
  assert.equal(client.requests.length, 0);
  await assert.rejects(fs.access(path.join(parent, "outside.txt")));
});

test("session/load restores durable metadata and replays the saved ACP transcript", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-store-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-workspace-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const store = new AcpSessionStore({ directory });
  const first = makeAgent({ sessionStore: store }).agent;
  const created = await first.newSession({ cwd });
  const saved = first.sessions.get(created.sessionId);
  saved.history = [
    { role: "user", content: "Add a health endpoint." },
    { role: "assistant", content: "I will inspect the server first." },
  ];
  saved.events = [
    {
      sessionUpdate: "user_message_chunk",
      messageId: "user-message-1",
      content: { type: "text", text: "Add a health endpoint." },
    },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "assistant-message-1",
      content: { type: "text", text: "I will inspect the server first." },
    },
  ];
  await first.persistSession(saved);

  const restarted = makeAgent({ sessionStore: store }).agent;
  const client = makeClient();
  const loaded = await restarted.loadSession({ sessionId: created.sessionId, cwd }, client);

  assert.equal(loaded.modes.currentModeId, "chatgpt");
  assert.equal(restarted.sessions.get(created.sessionId).providerSessionId, null);
  assert.match(restarted.sessions.get(created.sessionId).pendingHandoff, /Add a health endpoint/);
  assert.deepEqual(
    client.notifications.map((entry) => entry.params.update.sessionUpdate),
    ["user_message_chunk", "agent_message_chunk"],
  );
});

test("session/load marks interrupted tool operations without retrying them", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-store-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-workspace-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const store = new AcpSessionStore({ directory });
  const sessionId = "4a0e9c15-90c6-4e44-bd62-2e12d0315cd8";
  await store.save({
    id: sessionId,
    cwd,
    providerId: "chatgpt",
    turnNumber: 1,
    history: [{ role: "user", content: "Run the migration." }],
    pendingHandoff: null,
    events: [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-message-1",
        content: { type: "text", text: "Run the migration." },
      },
      { sessionUpdate: "tool_call", toolCallId: "tool-call-1", name: "run_command", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool-call-1", status: "in_progress" },
    ],
    turnInProgress: true,
  });

  const restarted = makeAgent({ sessionStore: store }).agent;
  const client = makeClient();
  await restarted.loadSession({ sessionId, cwd }, client);

  const restored = restarted.sessions.get(sessionId);
  const finalToolUpdate = restored.events.findLast((entry) => entry.sessionUpdate === "tool_call_update");
  assert.equal(finalToolUpdate.status, "failed");
  assert.equal(finalToolUpdate.rawOutput.outcome, "unknown");
  assert.equal(restored.turnInProgress, false);
  assert.equal(
    client.notifications.some((entry) =>
      String(entry.params.update.content?.text || "").includes("outcome is unknown"),
    ),
    true,
  );
});
