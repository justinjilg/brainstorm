import pino from "pino";

const isDebug = process.env.BRAINSTORM_LOG_LEVEL === "debug";
// In IPC mode, stdout is the NDJSON protocol channel — logs must go to stderr.
const isIPC = process.argv.includes("ipc");

export const logger = pino(
  {
    name: "brainstorm",
    level: process.env.BRAINSTORM_LOG_LEVEL ?? "info",
    transport: isDebug
      ? {
          target: "pino-pretty",
          options: { colorize: true, destination: isIPC ? 2 : 1 },
        }
      : undefined,
  },
  isIPC && !isDebug ? pino.destination(2) : undefined,
);

export function createLogger(name: string) {
  return logger.child({ module: name });
}
