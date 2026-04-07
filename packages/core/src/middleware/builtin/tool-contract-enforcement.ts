/**
 * Tool Contract Enforcement Middleware — validates tool arguments before execution.
 *
 * Uses the tool-contracts registry to check arguments against per-tool schemas.
 * Blocks tool calls that violate "block" severity contracts, warns on "warning" severity.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareBlock,
} from "../types.js";
import { validateToolContract } from "../../security/tool-contracts.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("tool-contract-enforcement");

export function createToolContractMiddleware(): AgentMiddleware {
  return {
    name: "tool-contract-enforcement",

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      const result = validateToolContract(call.name, call.input);

      if (!result.valid) {
        const blockViolations = result.violations.filter(
          (v) => v.severity === "block",
        );
        const reasons = blockViolations
          .map((v) => `${v.rule}: ${v.detail}`)
          .join("; ");

        log.warn(
          {
            tool: call.name,
            violations: blockViolations.map((v) => v.rule),
          },
          "Tool call blocked by contract violation",
        );

        return {
          blocked: true,
          reason: `Tool contract violation: ${reasons}`,
          middleware: "tool-contract-enforcement",
        };
      }

      // Log warnings but allow the call
      const warnings = result.violations.filter(
        (v) => v.severity === "warning",
      );
      if (warnings.length > 0) {
        log.info(
          {
            tool: call.name,
            warnings: warnings.map((v) => `${v.rule}: ${v.detail}`),
          },
          "Tool contract warnings (allowed with caution)",
        );
      }
    },
  };
}
