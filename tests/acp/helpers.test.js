import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHandoffPrompt,
  listProviderModes,
  parsePromptText,
  resolveDefaultProvider,
  validateWorkingDirectory,
} from "../../src/acp/helpers.js";

test("parsePromptText joins text blocks in order", () => {
  assert.equal(
    parsePromptText([
      { type: "text", text: "Inspect the project." },
      { type: "text", text: "Then explain the architecture." },
    ]),
    "Inspect the project.\nThen explain the architecture.",
  );
});

test("parsePromptText rejects non-text blocks instead of silently dropping them", () => {
  assert.throws(
    () => parsePromptText([{ type: "image", data: "..." }]),
    /Unsupported ACP prompt content type: image/,
  );
});

test("listProviderModes honours enabled-provider filtering and disabled configs", () => {
  const modes = listProviderModes(
    {
      chatgpt: { name: "ChatGPT" },
      gemini: { name: "Gemini" },
      deepseek: { name: "DeepSeek", disabled: true },
    },
    "chatgpt,gemini",
  );
  assert.deepEqual(modes.map((mode) => mode.id), ["chatgpt", "gemini"]);
});

test("resolveDefaultProvider falls back to the first enabled provider", () => {
  const modes = [
    { id: "gemini", name: "Gemini" },
    { id: "chatgpt", name: "ChatGPT" },
  ];
  assert.equal(resolveDefaultProvider(modes, "not-enabled"), "gemini");
});

test("buildHandoffPrompt preserves recent conversation roles and target provider", () => {
  const handoff = buildHandoffPrompt(
    [
      { role: "user", content: "Add authentication." },
      { role: "assistant", content: "I inspected the project." },
    ],
    "chatgpt",
    "gemini",
  );
  assert.match(handoff, /previous provider was chatgpt/);
  assert.match(handoff, /User: Add authentication/);
  assert.match(handoff, /Assistant: I inspected the project/);
});

test("validateWorkingDirectory requires an absolute path", () => {
  assert.throws(() => validateWorkingDirectory("relative/project"), /absolute path/);
  assert.equal(validateWorkingDirectory("/tmp/project"), "/tmp/project");
});
