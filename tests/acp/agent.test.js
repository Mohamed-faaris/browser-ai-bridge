import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserAiAcpAgent } from "../../src/acp/agent.js";

function makeAgent() {
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
