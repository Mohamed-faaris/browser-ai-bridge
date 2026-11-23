import path from "node:path";

export function parsePromptText(contentBlocks) {
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw new TypeError("The ACP prompt must contain at least one content block.");
  }

  const unsupported = contentBlocks.find((block) => block?.type !== "text");
  if (unsupported) {
    throw new TypeError(
      `Unsupported ACP prompt content type: ${String(unsupported.type)}. This gateway currently accepts text prompts only.`,
    );
  }

  const text = contentBlocks.map((block) => block.text).join("\n").trim();
  if (!text) throw new TypeError("The ACP prompt is empty.");
  return text;
}

export function listProviderModes(providerConfig, providerFilter = null) {
  const allowed = providerFilter
    ? new Set(
        String(providerFilter)
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;

  return Object.entries(providerConfig)
    .filter(([id, config]) => !config.disabled && (!allowed || allowed.has(id)))
    .map(([id, config]) => ({
      id,
      name: config.name || id,
      description: `Use ${config.name || id} through its authenticated web interface.`,
    }));
}

export function resolveDefaultProvider(providerModes, requestedProvider = "chatgpt") {
  if (!providerModes.length) {
    throw new Error("No browser AI providers are enabled.");
  }

  const requested = String(requestedProvider || "").toLowerCase();
  return providerModes.some((mode) => mode.id === requested)
    ? requested
    : providerModes[0].id;
}

export function buildHandoffPrompt(history, fromProvider, toProvider, maxChars = 6000) {
  const recent = Array.isArray(history) ? history.slice(-8) : [];
  const transcript = recent
    .map((entry) => {
      const role = entry.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${String(entry.content || "").trim()}`;
    })
    .filter((line) => !line.endsWith(":"))
    .join("\n\n");

  const header =
    `Continue an existing coding task. You are now answering through ${toProvider}; the previous provider was ${fromProvider}. The transcript below is a handoff summary, not a claim that you can access the previous website conversation. Preserve the user's requirements and continue from the latest state.\n\n`;
  if (!transcript) return header.slice(0, maxChars);

  const available = Math.max(0, maxChars - header.length);
  const clipped =
    transcript.length > available
      ? `[Earlier context omitted to fit the handoff budget.]\n\n${transcript.slice(-Math.max(0, available - 52))}`
      : transcript;

  return `${header}${clipped}`.slice(0, maxChars);
}

export function validateWorkingDirectory(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError(`ACP session cwd must be an absolute path: ${String(cwd)}`);
  }
  return path.resolve(cwd);
}
