import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveAcpStateDirectory(env = process.env) {
  const configured = String(env.BROWSER_AI_ACP_STATE_DIR || "").trim();
  if (configured) return path.resolve(configured);
  const stateHome = String(env.XDG_STATE_HOME || "").trim() || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "browser-ai-bridge", "acp");
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError("Invalid ACP session ID.");
  }
  return sessionId;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AcpSessionStore {
  constructor({ directory = resolveAcpStateDirectory(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.directory = path.resolve(directory);
    this.maxBytes = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_BYTES;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("ACP state path must be a real directory, not a symlink.");
    }
    await fs.chmod(this.directory, 0o700);
    this.directory = await fs.realpath(this.directory);
    this.initialized = true;
  }

  filePath(sessionId) {
    return path.join(this.directory, validateSessionId(sessionId) + ".json");
  }

  async save(session) {
    await this.initialize();
    const id = validateSessionId(session && session.id);
    if (typeof session.cwd !== "string" || !path.isAbsolute(session.cwd)) {
      throw new TypeError("A persisted ACP session requires an absolute working directory.");
    }
    if (typeof session.providerId !== "string" || !session.providerId) {
      throw new TypeError("A persisted ACP session requires a provider ID.");
    }
    if (!Array.isArray(session.history) || !Array.isArray(session.events)) {
      throw new TypeError("ACP session history and replay events must be arrays.");
    }

    const record = {
      schemaVersion: SCHEMA_VERSION,
      id,
      cwd: path.resolve(session.cwd),
      providerId: session.providerId,
      turnNumber: Number.isInteger(session.turnNumber) ? session.turnNumber : 0,
      history: cloneJson(session.history),
      pendingHandoff: typeof session.pendingHandoff === "string" ? session.pendingHandoff : null,
      events: cloneJson(session.events),
      turnInProgress: session.turnInProgress === true,
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) {
      throw new Error("ACP session state exceeded the " + this.maxBytes + "-byte persistence limit.");
    }

    const target = this.filePath(id);
    const temporary = target + "." + process.pid + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      const directoryHandle = await fs.open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load(sessionId) {
    await this.initialize();
    const target = this.filePath(sessionId);
    let serialized;
    try {
      serialized = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) {
      throw new Error("Persisted ACP session state exceeds the configured size limit.");
    }

    let record;
    try {
      record = JSON.parse(serialized);
    } catch {
      throw new Error("Persisted ACP session state is corrupt and cannot be recovered.");
    }
    if (
      record?.schemaVersion !== SCHEMA_VERSION ||
      record.id !== sessionId ||
      typeof record.cwd !== "string" ||
      !path.isAbsolute(record.cwd) ||
      typeof record.providerId !== "string" ||
      !Array.isArray(record.history) ||
      !Array.isArray(record.events)
    ) {
      throw new Error("Persisted ACP session state has an unsupported or invalid schema.");
    }
    return record;
  }

  async delete(sessionId) {
    await this.initialize();
    try {
      await fs.unlink(this.filePath(sessionId));
      const directoryHandle = await fs.open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}
