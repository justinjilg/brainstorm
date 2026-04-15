/**
 * Middleware Pipeline — chains middleware in order and runs them at each hook point.
 */

import type {
  AgentMiddleware,
  MiddlewareState,
  MiddlewareMessage,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "./types.js";
import { isBlocked } from "./types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("middleware-pipeline");

/** Middleware that cannot be removed via remove(). */
const PROTECTED_MIDDLEWARE = new Set(["security-scan", "subagent-limit"]);

export class MiddlewarePipeline {
  private middleware: AgentMiddleware[] = [];

  /** Add middleware to the pipeline. Order matters — first added runs first. */
  use(mw: AgentMiddleware): void {
    this.middleware.push(mw);
  }

  /** Remove middleware by name. Protected middleware (security-scan, subagent-limit) cannot be removed. */
  remove(name: string): void {
    if (PROTECTED_MIDDLEWARE.has(name)) {
      throw new Error(`Cannot remove protected middleware: ${name}`);
    }
    this.middleware = this.middleware.filter((mw) => mw.name !== name);
  }

  /** Get all registered middleware names. */
  list(): string[] {
    return this.middleware.map((mw) => mw.name);
  }

  /** Run beforeAgent hooks. Returns modified state. */
  runBeforeAgent(state: MiddlewareState): MiddlewareState {
    let current = state;
    for (const mw of this.middleware) {
      if (mw.beforeAgent) {
        const result = mw.beforeAgent(current);
        if (result) current = result;
      }
    }
    return current;
  }

  /** Run afterModel hooks. Returns modified message. */
  runAfterModel(message: MiddlewareMessage): MiddlewareMessage {
    let current = message;
    for (const mw of this.middleware) {
      if (mw.afterModel) {
        const result = mw.afterModel(current);
        if (result) current = result;
      }
    }
    return current;
  }

  /**
   * Run wrapToolCall hooks. Returns modified call or block signal.
   * FAIL-CLOSED: if any middleware throws, the tool call is blocked.
   */
  runWrapToolCall(
    call: MiddlewareToolCall,
  ): MiddlewareToolCall | MiddlewareBlock {
    let current: MiddlewareToolCall = call;
    for (const mw of this.middleware) {
      if (mw.wrapToolCall) {
        try {
          const result = mw.wrapToolCall(current);
          if (isBlocked(result)) return result;
          if (result) current = result;
        } catch (err) {
          log.error(
            { middleware: mw.name, tool: call.name, err },
            "Middleware wrapToolCall threw — blocking call (fail-closed)",
          );
          return {
            blocked: true,
            reason: `Security middleware error in ${mw.name}`,
            middleware: mw.name,
          };
        }
      }
    }
    return current;
  }

  /**
   * Run afterToolResult hooks. Returns modified result.
   * FAIL-SAFE for most middleware, but FAIL-CLOSED for secret-substitution
   * (a scrub failure must not leak secrets to the model).
   */
  runAfterToolResult(result: MiddlewareToolResult): MiddlewareToolResult {
    let current = result;
    for (const mw of this.middleware) {
      if (mw.afterToolResult) {
        try {
          const modified = mw.afterToolResult(current);
          if (modified) current = modified;
        } catch (err) {
          if (mw.name === "secret-substitution") {
            // FAIL-CLOSED: secret scrub failure must not leak secrets
            log.error(
              { middleware: mw.name, tool: result.name, err },
              "Secret scrubbing failed — redacting entire tool output to prevent leak",
            );
            return {
              ...current,
              output:
                "[REDACTED: secret scrubbing failed — output withheld for security]",
              ok: false,
              error: "Secret scrubbing failed",
            };
          }
          log.error(
            { middleware: mw.name, tool: result.name, err },
            "Middleware afterToolResult threw — continuing with unmodified result",
          );
        }
      }
    }
    return current;
  }
}
