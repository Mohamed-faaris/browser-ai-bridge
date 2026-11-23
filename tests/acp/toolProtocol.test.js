import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodingPrompt,
  formatWebToolResults,
  parseWebToolResponse,
  resolveEnabledTools,
} from "../../src/acp/toolProtocol.js";

function envelope(tool, args, id = "call-1") {
  return "```web_ai_tools\\n" + JSON.stringify({
    protocol: "web-ai-tools/v1",
    tool_calls: [{ id, tool, arguments: args }],
  }) + "\\n```";
}

test("plain text is treated as a final answer", () => {
  assert.deepEqual(parseWebToolResponse("The implementation is complete."), {
    type: "final",
    text: "The implementation is complete.",
  });
});

test("strict read_file envelope is parsed", () => {
  const result = parseWebToolResponse(envelope("read_file", { path: "src/index.js" }));
  assert.equal(result.type, "tool_calls");
  assert.equal(result.calls[0].tool, "read_file");
});

test("tool calls require the exact protocol envelope", () => {
  assert.throws(() => parseWebToolResponse(envelope("unknown_tool", {})), /Unknown tool/);
  assert.throws(
    () => parseWebToolResponse(envelope("read_file", { path: "a", unexpected: true })),
    /unsupported field/,
  );
  assert.throws(
    () => parseWebToolResponse(envelope("read_file", { path: "a" }) + "extra text"),
    /no surrounding prose/,
  );
});

test("duplicate tool-call IDs are rejected", () => {
  const block = "```web_ai_tools\\n" + JSON.stringify({
    protocol: "web-ai-tools/v1",
    tool_calls: [
      { id: "same", tool: "read_file", arguments: { path: "a" } },
      { id: "same", tool: "read_file", arguments: { path: "b" } },
    ],
  }) + "\\n```";
  assert.throws(() => parseWebToolResponse(block), /Duplicate tool call id/);
});

test("write and command tools require explicit environment opt-in", () => {
  const defaults = resolveEnabledTools({});
  assert.deepEqual([...defaults], ["read_file"]);
  assert.throws(
    () => parseWebToolResponse(envelope("write_file", { path: "a", content: "x" }), { enabledTools: defaults }),
    /Tool write_file is disabled/,
  );

  const enabled = resolveEnabledTools({
    BROWSER_AI_ENABLE_FILE_WRITES: "1",
    BROWSER_AI_ENABLE_COMMANDS: "1",
  });
  assert.deepEqual([...enabled], ["read_file", "write_file", "run_command"]);
  assert.equal(
    parseWebToolResponse(envelope("run_command", { command: "npm", args: ["test"] }), { enabledTools: enabled }).calls[0].tool,
    "run_command",
  );
});

test("coding prompt advertises only enabled tools", () => {
  const prompt = buildCodingPrompt("/workspace/project", "Fix the tests.", new Set(["read_file"]));
  assert.match(prompt, /read_file/);
  assert.doesNotMatch(prompt, /write_file\\(/);
  assert.doesNotMatch(prompt, /run_command\\(/);
});

test("tool results are truncated to fit a configured prompt budget", () => {
  const result = formatWebToolResults([
    { id: "1", tool: "read_file", status: "completed", output: "x".repeat(20000) },
  ], 3000);
  assert.ok(result.length < 5000);
  assert.match(result, /tool output truncated/);
});
