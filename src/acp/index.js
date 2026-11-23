#!/usr/bin/env node

// ACP owns stdin/stdout. Set this before dynamically importing browser/provider
// modules so their diagnostics are routed to stderr rather than corrupting NDJSON.
process.env.BROWSER_AI_ACP = "1";
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

import process from "node:process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [
  { connectToBrowser, cleanupBrowser },
  { sessionManager },
  { PROVIDER_CONFIG },
  { BrowserAiAcpAgent },
] = await Promise.all([
  import("../browser.js"),
  import("../session/index.js"),
  import("../config/providers.js"),
  import("./agent.js"),
]);

const implementation = new BrowserAiAcpAgent({
  acp,
  connectToBrowser,
  sessionManager,
  providerConfig: PROVIDER_CONFIG,
});

const agent = acp
  .agent({ name: "browser-ai-bridge" })
  .onRequest(acp.methods.agent.initialize, () => implementation.initialize())
  .onRequest(acp.methods.agent.session.new, ({ params }) =>
    implementation.newSession(params),
  )
  .onRequest(acp.methods.agent.authenticate, () =>
    implementation.authenticate(),
  )
  .onRequest(acp.methods.agent.session.setMode, ({ params }) =>
    implementation.setSessionMode(params),
  )
  .onRequest(acp.methods.agent.session.close, ({ params }) =>
    implementation.closeSession(params),
  )
  .onRequest(acp.methods.agent.session.delete, ({ params }) =>
    implementation.deleteSession(params),
  )
  .onRequest(acp.methods.agent.session.prompt, ({ params, client }) =>
    implementation.prompt(params, client),
  )
  .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
    implementation.cancel(params),
  );

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(output, input);

let shutdownPromise;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await implementation.shutdown();
    await cleanupBrowser().catch(() => {});
  })();
  return shutdownPromise;
}

process.stdin.once("end", () => {
  void shutdown().catch((error) => {
    process.stderr.write(`[ACP] Shutdown failed: ${error?.stack || error}\n`);
  });
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown()
      .catch((error) => {
        process.stderr.write(`[ACP] Shutdown failed: ${error?.stack || error}\n`);
      })
      .finally(() => process.exit(0));
  });
}

try {
  const connection = agent.connect(stream);
  await connection.closed;
} catch (error) {
  process.stderr.write(`[ACP] Gateway transport failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
} finally {
  await shutdown();
}
