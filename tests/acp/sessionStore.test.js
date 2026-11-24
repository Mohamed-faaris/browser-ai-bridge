import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AcpSessionStore, resolveAcpStateDirectory } from "../../src/acp/sessionStore.js";

async function makeDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeRecord(id) {
  return {
    id,
    cwd: "/tmp/project",
    providerId: "chatgpt",
    turnNumber: 3,
    history: [
      { role: "user", content: "Inspect the project." },
      { role: "assistant", content: "I inspected it." },
    ],
    pendingHandoff: null,
    events: [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "Inspect the project." },
      },
    ],
    turnInProgress: false,
    createdAt: 1730000000000,
  };
}

test("persists an ACP session and loads it after store recreation", async (t) => {
  const directory = await makeDirectory(t);
  const sessionId = "4a0e9c15-90c6-4e44-bd62-2e12d0315cd8";
  await new AcpSessionStore({ directory }).save(makeRecord(sessionId));
  const loaded = await new AcpSessionStore({ directory }).load(sessionId);
  assert.equal(loaded.id, sessionId);
  assert.equal(loaded.providerId, "chatgpt");
  assert.equal(loaded.history.length, 2);
  assert.equal(loaded.events[0].sessionUpdate, "user_message_chunk");
  assert.equal(loaded.turnInProgress, false);
  assert.equal("providerSessionId" in loaded, false);
});

test("session snapshots are stored with owner-only file permissions", async (t) => {
  const directory = await makeDirectory(t);
  const sessionId = "4a0e9c15-90c6-4e44-bd62-2e12d0315cd8";
  await new AcpSessionStore({ directory }).save(makeRecord(sessionId));
  const info = await fs.stat(path.join(directory, sessionId + ".json"));
  assert.equal(info.mode & 0o777, 0o600);
});

test("delete removes the durable snapshot and reports absent snapshots", async (t) => {
  const directory = await makeDirectory(t);
  const sessionId = "4a0e9c15-90c6-4e44-bd62-2e12d0315cd8";
  const store = new AcpSessionStore({ directory });
  await store.save(makeRecord(sessionId));
  assert.equal(await store.delete(sessionId), true);
  assert.equal(await store.load(sessionId), null);
  assert.equal(await store.delete(sessionId), false);
});

test("rejects unsafe session IDs and corrupt state", async (t) => {
  const directory = await makeDirectory(t);
  const store = new AcpSessionStore({ directory });
  await assert.rejects(store.load("../escape"), /Invalid ACP session ID/);
  const sessionId = "4a0e9c15-90c6-4e44-bd62-2e12d0315cd8";
  await fs.writeFile(path.join(directory, sessionId + ".json"), "{broken", { mode: 0o600 });
  await assert.rejects(store.load(sessionId), /corrupt/);
});

test("uses XDG state home or an explicit ACP state directory", () => {
  assert.equal(resolveAcpStateDirectory({ XDG_STATE_HOME: "/tmp/state" }), "/tmp/state/browser-ai-bridge/acp");
  assert.equal(resolveAcpStateDirectory({ BROWSER_AI_ACP_STATE_DIR: "/tmp/custom-acp" }), "/tmp/custom-acp");
});
