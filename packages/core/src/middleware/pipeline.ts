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
} from './types.js';
import { isBlocked } from './types.js';

export class MiddlewarePipeline {
  private middleware: AgentMiddleware[] = [];

  /** Add middleware to the pipeline. Order matters — first added runs first. */
  use(mw: AgentMiddleware): void {
    this.middleware.push(mw);
  }

  /** Remove middleware by name. */
  remove(name: string): void {
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

  /** Run wrapToolCall hooks. Returns modified call or block signal. */
  runWrapToolCall(call: MiddlewareToolCall): MiddlewareToolCall | MiddlewareBlock {
    let current: MiddlewareToolCall = call;
    for (const mw of this.middleware) {
      if (mw.wrapToolCall) {
        const result = mw.wrapToolCall(current);
        if (isBlocked(result)) return result;
        if (result) current = result;
      }
    }
    return current;
  }

  /** Run afterToolResult hooks. Returns modified result. */
  runAfterToolResult(result: MiddlewareToolResult): MiddlewareToolResult {
    let current = result;
    for (const mw of this.middleware) {
      if (mw.afterToolResult) {
        const modified = mw.afterToolResult(current);
        if (modified) current = modified;
      }
    }
    return current;
  }
}
