import pino from 'pino';

const isDebug = process.env.BRAINSTORM_LOG_LEVEL === 'debug';

export const logger = pino({
  name: 'brainstorm',
  level: process.env.BRAINSTORM_LOG_LEVEL ?? 'info',
  transport: isDebug
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
