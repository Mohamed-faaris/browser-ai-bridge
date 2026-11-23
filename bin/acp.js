#!/usr/bin/env node
import("../src/acp/index.js").catch((error) => {
  process.stderr.write(`[ACP] Failed to start: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
