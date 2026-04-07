import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Security tool — vulnerability and compliance management.
 *
 * Enables agents to monitor and respond to security alerts,
 * track dependency vulnerabilities, and export SBOMs.
 */
export const ghSecurityTool = defineTool({
  name: "gh_security",
  description:
    "GitHub security management. Actions: dependabot (list/view/dismiss dependency vulnerability alerts), code-scanning (list/view CodeQL alerts), secret-scanning (list/view exposed secret alerts), sbom (export software bill of materials).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum(["dependabot", "code-scanning", "secret-scanning", "sbom"])
      .describe("Security action"),
    // sub-action for alert types
    subAction: z
      .enum(["list", "view", "dismiss", "reopen"])
      .optional()
      .describe("Sub-action (default: list)"),
    // alert fields
    alertNumber: z
      .number()
      .optional()
      .describe("Alert number (for view/dismiss)"),
    dismissReason: z
      .string()
      .optional()
      .describe("Reason for dismissing alert"),
    // filter fields
    state: z
      .enum(["open", "closed", "dismissed", "fixed"])
      .optional()
      .describe("Filter by state"),
    severity: z
      .enum(["critical", "high", "medium", "low"])
      .optional()
      .describe("Filter by severity"),
    limit: z.number().optional().describe("Max items (default: 10)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };
    const sub = input.subAction ?? "list";

    try {
      switch (input.action) {
        case "dependabot": {
          if (sub === "list") {
            const args = [
              "api",
              "repos/{owner}/{repo}/dependabot/alerts",
              "--jq",
              ".[] | {number: .number, state: .state, severity: .security_advisory.severity, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, summary: .security_advisory.summary, url: .html_url}",
            ];
            const { stdout } = await execFileAsync("gh", args, opts);
            let alerts = stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (input.state)
              alerts = alerts.filter((a: any) => a.state === input.state);
            if (input.severity)
              alerts = alerts.filter((a: any) => a.severity === input.severity);
            return { alerts: alerts.slice(0, input.limit ?? 10) };
          }
          if (sub === "view" && input.alertNumber) {
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/dependabot/alerts/${input.alertNumber}`,
              ],
              opts,
            );
            return { alert: JSON.parse(stdout) };
          }
          if (sub === "dismiss" && input.alertNumber) {
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/dependabot/alerts/${input.alertNumber}`,
                "--method",
                "PATCH",
                "--field",
                "state=dismissed",
                "--field",
                `dismissed_reason=${input.dismissReason ?? "tolerable_risk"}`,
              ],
              opts,
            );
            return { success: true, alert: JSON.parse(stdout) };
          }
          return { error: "Invalid subAction or missing alertNumber" };
        }

        case "code-scanning": {
          if (sub === "list") {
            const args = [
              "api",
              "repos/{owner}/{repo}/code-scanning/alerts",
              "--jq",
              ".[] | {number: .number, state: .state, severity: .rule.severity, rule: .rule.id, description: .rule.description, tool: .tool.name, url: .html_url}",
            ];
            const { stdout } = await execFileAsync("gh", args, opts);
            let alerts = stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (input.state)
              alerts = alerts.filter((a: any) => a.state === input.state);
            if (input.severity)
              alerts = alerts.filter((a: any) => a.severity === input.severity);
            return { alerts: alerts.slice(0, input.limit ?? 10) };
          }
          if (sub === "view" && input.alertNumber) {
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/code-scanning/alerts/${input.alertNumber}`,
              ],
              opts,
            );
            return { alert: JSON.parse(stdout) };
          }
          return { error: "Invalid subAction or missing alertNumber" };
        }

        case "secret-scanning": {
          if (sub === "list") {
            const args = [
              "api",
              "repos/{owner}/{repo}/secret-scanning/alerts",
              "--jq",
              ".[] | {number: .number, state: .state, secret_type: .secret_type, secret_type_display_name: .secret_type_display_name, url: .html_url, created_at: .created_at}",
            ];
            const { stdout } = await execFileAsync("gh", args, opts);
            let alerts = stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (input.state)
              alerts = alerts.filter((a: any) => a.state === input.state);
            return { alerts: alerts.slice(0, input.limit ?? 10) };
          }
          if (sub === "view" && input.alertNumber) {
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/secret-scanning/alerts/${input.alertNumber}`,
              ],
              opts,
            );
            return { alert: JSON.parse(stdout) };
          }
          return { error: "Invalid subAction or missing alertNumber" };
        }

        case "sbom": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              "repos/{owner}/{repo}/dependency-graph/sbom",
              "--jq",
              ".sbom",
            ],
            opts,
          );
          return { sbom: JSON.parse(stdout) };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
