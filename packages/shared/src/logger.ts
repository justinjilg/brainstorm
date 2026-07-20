import pino from "pino";

const isDebug = process.env.BRAINSTORM_LOG_LEVEL === "debug";

/** stdout is a machine protocol channel for IPC, JSON, and event-stream modes. */
export function isStructuredOutputArgs(argv: string[]): boolean {
  return (
    argv.includes("ipc") || argv.includes("--json") || argv.includes("--events")
  );
}

const isStructuredOutput = isStructuredOutputArgs(process.argv);

export const logger = pino(
  {
    name: "brainstorm",
    level: process.env.BRAINSTORM_LOG_LEVEL ?? "info",
    transport: isDebug
      ? {
          target: "pino-pretty",
          options: { colorize: true, destination: isStructuredOutput ? 2 : 1 },
        }
      : undefined,
  },
  isStructuredOutput && !isDebug ? pino.destination(2) : undefined,
);

export function createLogger(name: string) {
  return logger.child({ module: name });
}
