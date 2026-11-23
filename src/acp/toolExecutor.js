import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsConstants from "node:fs";
import path from "node:path";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function workspaceRoot(cwd) {
  const root = await fs.realpath(cwd);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("The ACP session working directory is not a directory.");
  return root;
}

async function resolveExistingFile(root, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed; use a path relative to the project directory.");
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error("The requested path escapes the project workspace.");
  const actual = await fs.realpath(target);
  if (!isInside(root, actual)) throw new Error("The requested file resolves outside the project workspace.");
  const stat = await fs.stat(actual);
  if (!stat.isFile()) throw new Error("The requested path is not a regular file.");
  return actual;
}

async function resolveWriteTarget(root, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed; use a path relative to the project directory.");
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target) || target === root) {
    throw new Error("The requested path escapes the project workspace or names the workspace directory.");
  }

  const parent = await fs.realpath(path.dirname(target));
  if (!isInside(root, parent)) throw new Error("The target parent resolves outside the project workspace.");

  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Writing through symbolic links is not allowed.");
    if (!stat.isFile()) throw new Error("The target exists and is not a regular file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path.join(parent, path.basename(target));
}

function pushBounded(chunks, state, chunk, maxBytes) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  chunks.push(text);
  const chunkBytes = Buffer.byteLength(text);
  state.bytes += chunkBytes;
  state.totalBytes += chunkBytes;
  while (state.bytes > maxBytes && chunks.length) {
    const removed = chunks.shift();
    state.bytes -= Buffer.byteLength(removed);
  }
}

async function runCommand(args, cwd, signal) {
  const timeoutMs = args.timeout_ms ?? 60000;
  const maxOutputBytes = 64 * 1024;
  const output = [];
  const outputState = { bytes: 0, totalBytes: 0 };

  if (signal.aborted) throw new Error("Command cancelled before it started.");

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(args.command, args.args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1500);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeoutMs);
    timer.unref?.();

    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => pushBounded(output, outputState, chunk, maxOutputBytes));
    child.stderr.on("data", (chunk) => pushBounded(output, outputState, chunk, maxOutputBytes));
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, exitSignal) => {
      const text = output.join("");
      const status = timedOut ? "timeout" : signal.aborted ? "cancelled" : "completed";
      finish(resolve, {
        status,
        exitCode: code,
        signal: exitSignal,
        output: text,
        truncated: outputState.totalBytes > maxOutputBytes,
        command: args.command,
        args: args.args,
      });
    });
  });
}

export async function executeWorkspaceTool(call, cwd, signal) {
  const root = await workspaceRoot(cwd);

  switch (call.tool) {
    case "read_file": {
      const filename = await resolveExistingFile(root, call.arguments.path);
      const stat = await fs.stat(filename);
      if (stat.size > 256_000) throw new Error("File exceeds the 256 KB read limit.");
      const content = await fs.readFile(filename, "utf8");
      return { path: path.relative(root, filename), content, bytes: stat.size };
    }

    case "write_file": {
      const filename = await resolveWriteTarget(root, call.arguments.path);
      const flags =
        fsConstants.constants.O_WRONLY |
        fsConstants.constants.O_CREAT |
        fsConstants.constants.O_TRUNC |
        (fsConstants.constants.O_NOFOLLOW || 0);
      const handle = await fs.open(filename, flags, 0o600);
      try {
        await handle.writeFile(call.arguments.content, "utf8");
      } finally {
        await handle.close();
      }
      return {
        path: path.relative(root, filename),
        bytesWritten: Buffer.byteLength(call.arguments.content),
      };
    }

    case "run_command":
      return await runCommand(call.arguments, root, signal);

    default:
      throw new Error(`Unsupported workspace tool: ${call.tool}`);
  }
}
