#!/usr/bin/env node
/**
 * Entry point for the `brainstorm-broker` daemon. Reads port from
 * BRAINSTORM_BROKER_PORT (default 7900), boots the server, and awaits
 * SIGTERM/SIGINT for clean shutdown.
 */

import { createBroker, DEFAULT_BROKER_PORT } from "./daemon.js";

async function main() {
  const port = parseInt(
    process.env.BRAINSTORM_BROKER_PORT ?? String(DEFAULT_BROKER_PORT),
    10,
  );
  const broker = createBroker({ port });
  await broker.start();

  const shutdown = async (): Promise<void> => {
    try {
      await broker.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive; Node would otherwise exit once the main
  // function returns because the http server's handle is unref'd in some
  // runtimes.
  process.stderr.write(
    `[brainstorm-broker] listening on 127.0.0.1:${broker.port()}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[brainstorm-broker] fatal: ${err}\n`);
  process.exit(1);
});
