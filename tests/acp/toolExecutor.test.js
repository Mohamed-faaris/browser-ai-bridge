import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeWorkspaceTool } from "../../src/acp/toolExecutor.js";

test("read_file reads only files beneath the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "app.js"), "export const value = 42;");

  const result = await executeWorkspaceTool(
    { tool: "read_file", arguments: { path: "src/app.js" } },
    root,
    new AbortController().signal,
  );
  assert.equal(result.content, "export const value = 42;");
});

test("read_file rejects traversal and symlink escapes", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "outside.txt");
  await fs.mkdir(root);
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(root, "secret-link"));

  await assert.rejects(
    executeWorkspaceTool(
      { tool: "read_file", arguments: { path: "../outside.txt" } },
      root,
      new AbortController().signal,
    ),
    /escapes the project workspace/,
  );
  await assert.rejects(
    executeWorkspaceTool(
      { tool: "read_file", arguments: { path: "secret-link" } },
      root,
      new AbortController().signal,
    ),
    /resolves outside the project workspace/,
  );
});

test("write_file creates a file beneath the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await executeWorkspaceTool(
    { tool: "write_file", arguments: { path: "new.txt", content: "approved content" } },
    root,
    new AbortController().signal,
  );
  assert.equal(result.bytesWritten, Buffer.byteLength("approved content"));
  assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "approved content");
});

test("write_file refuses to follow symlink targets", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ai-acp-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "outside.txt");
  await fs.mkdir(root);
  await fs.writeFile(outside, "keep this");
  await fs.symlink(outside, path.join(root, "link.txt"));

  await assert.rejects(
    executeWorkspaceTool(
      { tool: "write_file", arguments: { path: "link.txt", content: "do not replace" } },
      root,
      new AbortController().signal,
    ),
    /symbolic links/,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "keep this");
});
