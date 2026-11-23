const PROTOCOL = "web-ai-tools/v1";
const MAX_TOOL_CALLS = 6;
const MAX_PATH_CHARS = 2048;
const MAX_CONTENT_CHARS = 256_000;

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new TypeError(`${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
  }
}

function requireString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new TypeError(`${label} exceeds the ${maxLength}-character limit.`);
  }
  return value;
}

export function parseWebToolResponse(responseText) {
  const text = String(responseText || "").trim();
  const blocks = [...text.matchAll(/```web_ai_tools\s*([\s\S]*?)```/gi)];

  if (blocks.length === 0) {
    if (/web_ai_tools/i.test(text)) {
      throw new TypeError("The response mentioned the tool protocol but did not contain a valid fenced web_ai_tools block.");
    }
    return { type: "final", text };
  }

  if (blocks.length !== 1 || text.replace(blocks[0][0], "").trim()) {
    throw new TypeError("A tool response must contain exactly one web_ai_tools block and no surrounding prose.");
  }

  let envelope;
  try {
    envelope = JSON.parse(blocks[0][1].trim());
  } catch (error) {
    throw new TypeError(`The web_ai_tools block is not valid JSON: ${error.message}`);
  }

  exactKeys(envelope, ["protocol", "tool_calls"], "Tool envelope");
  if (envelope.protocol !== PROTOCOL) {
    throw new TypeError(`Unsupported tool protocol. Expected ${PROTOCOL}.`);
  }
  if (!Array.isArray(envelope.tool_calls) || envelope.tool_calls.length === 0) {
    throw new TypeError("tool_calls must be a non-empty array.");
  }
  if (envelope.tool_calls.length > MAX_TOOL_CALLS) {
    throw new TypeError(`At most ${MAX_TOOL_CALLS} tool calls are allowed per model response.`);
  }

  const ids = new Set();
  const calls = envelope.tool_calls.map((call, index) => {
    exactKeys(call, ["id", "tool", "arguments"], `tool_calls[${index}]`);
    const id = requireString(call.id, `tool_calls[${index}].id`, 100);
    if (ids.has(id)) throw new TypeError(`Duplicate tool call id: ${id}`);
    ids.add(id);
    const tool = requireString(call.tool, `tool_calls[${index}].tool`, 64);
    const args = call.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError(`Arguments for ${tool} must be an object.`);
    }

    switch (tool) {
      case "read_file":
        exactKeys(args, ["path"], `Arguments for ${tool}`);
        requireString(args.path, "path", MAX_PATH_CHARS);
        break;
      case "write_file":
        exactKeys(args, ["path", "content"], `Arguments for ${tool}`);
        requireString(args.path, "path", MAX_PATH_CHARS);
        if (typeof args.content !== "string" || args.content.length > MAX_CONTENT_CHARS) {
          throw new TypeError("content must be a string no longer than 256000 characters.");
        }
        break;
      case "run_command":
        exactKeys(args, ["command", "args", "timeout_ms"], `Arguments for ${tool}`);
        requireString(args.command, "command", 256);
        if (!Array.isArray(args.args) || args.args.length > 128 ||
            args.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 16384)) {
          throw new TypeError("args must be an array of at most 128 strings (each no longer than 16384 characters).");
        }
        if (args.timeout_ms !== undefined &&
            (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 120000)) {
          throw new TypeError("timeout_ms must be an integer between 1000 and 120000.");
        }
        break;
      default:
        throw new TypeError(`Unknown tool: ${tool}`);
    }

    return { id, tool, arguments: args };
  });

  return { type: "tool_calls", calls };
}

export function buildCodingPrompt(cwd, userPrompt) {
  return [
    "You are a coding agent operating through Browser AI Bridge.",
    `The project working directory is: ${cwd}`,
    "You may inspect or modify project files and run commands only by returning the strict tool protocol below. Do not claim that an operation was performed unless its tool result is returned.",
    "Available tools:",
    "1. read_file({path}) — read a UTF-8 file relative to the project directory. Reads are workspace-scoped.",
    "2. write_file({path, content}) — create or replace a UTF-8 file relative to the project directory. This requires user approval in T3.",
    "3. run_command({command, args, timeout_ms?}) — execute a program with an argument array in the project directory (no shell interpolation). This requires user approval in T3.",
    "When you need tools, respond with exactly one fenced web_ai_tools block and no surrounding prose:",
    "```web_ai_tools",
    JSON.stringify({
      protocol: "web-ai-tools/v1",
      tool_calls: [
        { id: "unique-call-id", tool: "read_file", arguments: { path: "src/index.js" } },
      ],
    }, null, 2),
    "```",
    "After tools run, you will receive a web_ai_tool_results block. Continue the task using the real results. You may make multiple tool rounds. When finished, answer normally without a web_ai_tools block.",
    "Never invent file contents, command output or tool results. If an operation is denied or fails, report that accurately.",
    "",
    "USER TASK:",
    userPrompt,
  ].join("\n");
}

export function formatWebToolResults(results) {
  return [
    "Tool execution results follow. They are authoritative. Continue the task using these results.",
    "```web_ai_tool_results",
    JSON.stringify({ protocol: PROTOCOL, results }, null, 2),
    "```",
    "Return another web_ai_tools block if additional operations are needed, otherwise provide the final answer.",
  ].join("\n");
}
