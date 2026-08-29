/**
 * `brainstorm` agents commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { buildSystemPrompt } from "@brainst0rm/core";
import { AgentManager, parseAgentNL } from "@brainst0rm/agents";
import {
  runWorkflow,
  getPresetWorkflow,
  autoSelectPreset,
  PRESET_WORKFLOWS,
} from "@brainst0rm/workflow";
import { join } from "node:path";
import { resolveProviderKeys } from "./_context.js";

export function registerAgentsCommands(program: Command): void {
  const agentCmd = program.command("agent").description("Manage named agents");

  agentCmd
    .command("create")
    .description("Create an agent (structured flags or natural language)")
    .argument(
      "[description...]",
      'Natural language description (e.g., "architect using opus with $30 budget")',
    )
    .option("--id <id>", "Agent ID")
    .option("--model <model>", "Model ID or alias")
    .option(
      "--role <role>",
      "Agent role (architect|coder|reviewer|debugger|analyst|custom)",
    )
    .option("--budget <usd>", "Per-workflow budget in USD", parseFloat)
    .option("--budget-daily <usd>", "Daily budget in USD", parseFloat)
    .option("--description <desc>", "What this agent does")
    .option("--confidence <threshold>", "Confidence threshold 0-1", parseFloat)
    .action(async (descWords: string[], opts: any) => {
      const config = loadConfig();
      const db = getDb();
      const manager = new AgentManager(db, config);

      // Try natural language first
      const nlInput = descWords.join(" ");
      const parseResult = nlInput ? parseAgentNL(nlInput) : null;
      const parsed = parseResult?.intent;

      if (nlInput && !parsed && parseResult?.suggestion) {
        console.log(
          `  Could not parse agent definition.\n  ${parseResult.suggestion}`,
        );
        process.exit(1);
      }

      const id = opts.id ?? parsed?.id ?? "agent-" + Date.now().toString(36);
      const role = opts.role ?? parsed?.role ?? "custom";
      const modelId = opts.model ?? parsed?.modelId ?? "auto";
      const budget = opts.budget ?? parsed?.budget;
      const budgetDaily = opts.budgetDaily ?? parsed?.budgetDaily;
      const description = opts.description ?? parsed?.description ?? "";
      const confidence = opts.confidence ?? 0.7;

      const agent = manager.create({
        id,
        displayName: id.charAt(0).toUpperCase() + id.slice(1),
        role,
        description,
        modelId,
        allowedTools: role === "coder" ? "all" : ["file_read", "glob", "grep"],
        budget: {
          perWorkflow: budget,
          daily: budgetDaily,
          exhaustionAction: "downgrade",
        },
        confidenceThreshold: confidence,
        maxSteps: 10,
        fallbackChain: [],
        guardrails: { pii: parsed?.guardrailsPii },
        lifecycle: "active",
      });

      console.log(`\n  Created agent '${agent.id}'`);
      console.log(`    Role: ${agent.role}`);
      console.log(`    Model: ${agent.modelId}`);
      if (agent.budget.perWorkflow)
        console.log(`    Budget: $${agent.budget.perWorkflow}/workflow`);
      if (agent.budget.daily)
        console.log(`    Daily: $${agent.budget.daily}/day`);
      if (agent.guardrails.pii) console.log(`    Guardrails: PII enabled`);
      console.log();
    });

  agentCmd
    .command("list")
    .description("List all agents")
    .action(async () => {
      const config = loadConfig();
      const db = getDb();
      const manager = new AgentManager(db, config);
      const agents = manager.list();

      console.log("\n  Agents:\n");
      if (agents.length === 0) {
        console.log(
          "    No agents defined. Create one with: storm agent create <description>",
        );
      }
      for (const a of agents) {
        const budget = a.budget.perWorkflow
          ? `$${a.budget.perWorkflow}/wf`
          : a.budget.daily
            ? `$${a.budget.daily}/day`
            : "unlimited";
        console.log(
          `    ${a.id}  (${a.role})  model: ${a.modelId}  budget: ${budget}`,
        );
      }
      console.log();
    });

  agentCmd
    .command("show")
    .description("Show agent details")
    .argument("<id>", "Agent ID")
    .action(async (id: string) => {
      const config = loadConfig();
      const db = getDb();
      const manager = new AgentManager(db, config);
      const agent = manager.get(id);

      if (!agent) {
        console.error(`  Agent '${id}' not found.`);
        process.exit(1);
      }

      console.log(`\n  Agent: ${agent.id}`);
      console.log(`    Display Name: ${agent.displayName}`);
      console.log(`    Role: ${agent.role}`);
      console.log(`    Model: ${agent.modelId}`);
      console.log(`    Description: ${agent.description || "(none)"}`);
      console.log(`    Allowed Tools: ${JSON.stringify(agent.allowedTools)}`);
      console.log(
        `    Budget/Workflow: ${agent.budget.perWorkflow ? `$${agent.budget.perWorkflow}` : "unlimited"}`,
      );
      console.log(
        `    Budget/Daily: ${agent.budget.daily ? `$${agent.budget.daily}` : "unlimited"}`,
      );
      console.log(`    Confidence: ${agent.confidenceThreshold}`);
      console.log(
        `    Fallback Chain: ${agent.fallbackChain.length > 0 ? agent.fallbackChain.join(" → ") : "(none)"}`,
      );
      console.log(`    Guardrails: PII=${agent.guardrails.pii ?? false}`);
      console.log(`    Status: ${agent.lifecycle}`);
      console.log();
    });

  agentCmd
    .command("delete")
    .description("Delete an agent")
    .argument("<id>", "Agent ID")
    .action(async (id: string) => {
      const config = loadConfig();
      const db = getDb();
      const manager = new AgentManager(db, config);
      try {
        const deleted = manager.delete(id);
        if (deleted) console.log(`  Deleted agent '${id}'.`);
        else console.error(`  Agent '${id}' not found.`);
      } catch (e: any) {
        console.error(`  ${e.message}`);
      }
    });

  // ── Peer coordination (Phase 3) ─────────────────────────────────────
  //
  // Manual test surface for the localhost broker. Each invocation talks to
  // the running broker directly (auto-spawning if needed) rather than joining
  // the peer mesh as a long-running session. Useful for operators and for
  // integration tests that exercise cross-session messaging without a live
  // storm chat process.

  const peerCmd = program
    .command("peer")
    .description("Cross-session peer coordination via local broker");

  async function peerEphemeralClient(summary: string): Promise<{
    client: import("@brainst0rm/broker").BrokerClient;
    id: string;
  }> {
    const apiKey = process.env.BRAINSTORM_ROUTER_API_KEY;
    if (!apiKey) {
      console.error(
        "peer commands require BRAINSTORM_ROUTER_API_KEY (tenant fingerprint source)",
      );
      process.exit(1);
    }
    const { BrokerClient, ensureBroker } = await import("@brainst0rm/broker");
    const port = await ensureBroker();
    const client = new BrokerClient({
      port,
      apiKey,
      pid: process.pid,
      cwd: process.cwd(),
      summary,
      // Short-lived — no heartbeats needed; we'll unregister on completion.
      heartbeatIntervalMs: 60_000,
      pollIntervalMs: 60_000,
    });
    const id = await client.start();
    return { client, id };
  }

  peerCmd
    .command("list")
    .description("List other storm CLI sessions visible to this tenant")
    .option(
      "--scope <scope>",
      "machine | directory | repo (default: machine)",
      "machine",
    )
    .action(async (opts: { scope?: string }) => {
      const { client } = await peerEphemeralClient("peer list (one-shot)");
      try {
        const scope = (opts.scope ?? "machine") as
          | "machine"
          | "directory"
          | "repo";
        const peers = await client.listPeers(scope);
        if (peers.length === 0) {
          console.log("(no peers)");
        } else {
          for (const p of peers) {
            const parts = [
              p.id,
              `pid=${p.pid}`,
              p.cwd,
              p.tty ? `tty=${p.tty}` : "",
            ].filter(Boolean);
            console.log(parts.join("  "));
            if (p.summary) console.log(`  ${p.summary}`);
          }
        }
      } finally {
        await client.stop();
      }
    });

  peerCmd
    .command("send")
    .description("Send a message to a peer by id")
    .argument("<peerId>", "target peer id (from `peer list`)")
    .argument("<message...>", "message text")
    .action(async (peerId: string, words: string[]) => {
      const text = words.join(" ");
      const { client } = await peerEphemeralClient("peer send (one-shot)");
      try {
        await client.sendMessage(peerId, text);
        console.log(`sent to ${peerId}`);
      } catch (err) {
        console.error(
          `send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      } finally {
        await client.stop();
      }
    });

  peerCmd
    .command("messages")
    .description("Drain pending inbound messages for this session")
    .action(async () => {
      const { client } = await peerEphemeralClient("peer messages (one-shot)");
      try {
        // One-shot: trigger a poll immediately by registering a handler +
        // directly calling the broker. Simpler: subscribe and wait 1.2s
        // so the poll timer fires once (pollInterval=60s; we'd wait too long).
        // Instead, call the poll endpoint directly via the client's http path.
        const collected: Array<{
          from_id: string;
          text: string;
          sent_at: string;
        }> = [];
        const unsub = client.onMessage((msg) => {
          collected.push({
            from_id: msg.from_id,
            text: msg.text,
            sent_at: msg.sent_at,
          });
        });
        // Force a poll — cheaper than waiting for the interval.
        const port = process.env.BRAINSTORM_BROKER_PORT ?? "7900";
        await fetch(`http://127.0.0.1:${port}/poll-messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: client.getPeerId() }),
        }).then(async (res) => {
          const body = (await res.json()) as {
            messages: Array<{
              from_id: string;
              text: string;
              sent_at: string;
            }>;
          };
          for (const m of body.messages) collected.push(m);
        });
        unsub();
        if (collected.length === 0) {
          console.log("(no pending messages)");
        } else {
          for (const m of collected) {
            console.log(`[${m.sent_at}] from ${m.from_id}: ${m.text}`);
          }
        }
      } finally {
        await client.stop();
      }
    });

  peerCmd
    .command("set-summary")
    .description("Update the summary shown to other peers")
    .argument("<summary...>", "summary text")
    .action(async (words: string[]) => {
      const summary = words.join(" ");
      const { client } = await peerEphemeralClient(summary);
      try {
        await client.setSummary(summary);
        console.log(`summary updated: ${summary}`);
      } finally {
        await client.stop();
      }
    });

  peerCmd
    .command("health")
    .description("Check broker liveness + peer count")
    .action(async () => {
      const { client } = await peerEphemeralClient("peer health (one-shot)");
      try {
        const h = await client.health();
        console.log(JSON.stringify(h, null, 2));
      } finally {
        await client.stop();
      }
    });

  // ── Workflow Commands ──────────────────────────────────────────────

  const workflowCmd = program
    .command("workflow")
    .description("Run multi-agent workflows");

  workflowCmd
    .command("list")
    .description("List available workflows")
    .action(async () => {
      console.log("\n  Workflows:\n");
      for (const w of PRESET_WORKFLOWS) {
        const steps = w.steps.map((s) => s.agentRole).join(" → ");
        console.log(`    ${w.id}  — ${w.description}`);
        console.log(
          `      Steps: ${steps}  (mode: ${w.communicationMode}, max loops: ${w.maxIterations})`,
        );
      }
      console.log();
    });

  workflowCmd
    .command("run")
    .description("Run a workflow")
    .argument("<preset>", "Workflow preset ID or natural language description")
    .argument("[description...]", "What to build/fix/review")
    .option(
      "--agents <mapping>",
      'Agent role overrides (e.g., "architect=my-arch,coder=my-coder")',
    )
    .option("--mode <mode>", "Communication mode (handoff|shared)", "handoff")
    .option(
      "--step-model <overrides...>",
      'Per-step model overrides (e.g., "plan=claude-opus-4.6 code=claude-sonnet-4.6")',
    )
    .option("--dry-run", "Show cost forecast only")
    .action(async (preset: string, descWords: string[], opts: any) => {
      const description = descWords.join(" ") || preset;

      // Resolve workflow
      let workflow = getPresetWorkflow(preset);
      if (!workflow) {
        const autoPreset = autoSelectPreset(preset + " " + description);
        if (autoPreset) workflow = getPresetWorkflow(autoPreset);
      }
      if (!workflow) {
        console.error(
          `  Unknown workflow: '${preset}'. Run 'storm workflow list' to see available workflows.`,
        );
        process.exit(1);
      }

      const config = loadConfig();
      const db = getDb();
      const registry = await createProviderRegistry(
        config,
        await resolveProviderKeys(),
      );
      const costTracker = new CostTracker(db, config.budget);
      const projectPath = process.cwd();
      const { frontmatter } = buildSystemPrompt(projectPath);
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );
      const agentManager = new AgentManager(db, config);

      // Parse agent overrides
      const agentOverrides: Record<string, string> = {};
      if (opts.agents) {
        for (const pair of opts.agents.split(",")) {
          const [role, agentId] = pair.split("=");
          if (role && agentId) agentOverrides[role.trim()] = agentId.trim();
        }
      }

      // Parse step model overrides: --step-model "plan=claude-opus-4.6" "code=claude-sonnet-4.6"
      const stepModelOverrides: Record<string, string> = {};
      if (opts.stepModel) {
        const items = Array.isArray(opts.stepModel)
          ? opts.stepModel
          : [opts.stepModel];
        for (const item of items) {
          for (const pair of (item as string).split(/\s+/)) {
            const [step, model] = pair.split("=");
            if (step && model) stepModelOverrides[step.trim()] = model.trim();
          }
        }
      }

      console.log(`\n  Workflow: ${workflow.name}`);
      console.log(`  Request: "${description}"`);
      console.log(
        `  Steps: ${workflow.steps.map((s) => s.agentRole).join(" → ")}`,
      );
      if (Object.keys(stepModelOverrides).length > 0) {
        console.log(
          `  Model overrides: ${Object.entries(stepModelOverrides)
            .map(([s, m]) => `${s}=${m}`)
            .join(", ")}`,
        );
      }
      console.log();

      for await (const event of runWorkflow(
        workflow,
        description,
        agentOverrides,
        {
          config,
          db,
          registry,
          router,
          costTracker,
          agentManager,
          projectPath,
          stepModelOverrides,
        },
      )) {
        switch (event.type) {
          case "cost-forecast":
            console.log(`  Estimated cost: $${event.estimated.toFixed(4)}`);
            for (const b of event.breakdown) {
              console.log(`    ${b.step}: $${b.cost.toFixed(4)}`);
            }
            if (opts.dryRun) {
              console.log("\n  (dry run — not executing)\n");
              return;
            }
            console.log();
            break;
          case "step-started":
            process.stdout.write(
              `  [${event.agent.role}] ${event.agent.displayName} (${event.agent.modelId})...`,
            );
            break;
          case "step-progress":
            if (event.event.type === "text-delta") {
              // Don't flood output — just show dots for progress
            }
            if (event.event.type === "routing") {
              process.stdout.write(` → ${event.event.decision.model.name}`);
            }
            break;
          case "step-completed":
            console.log(
              ` done ($${event.step.cost.toFixed(4)}, confidence: ${event.artifact.confidence.toFixed(2)})`,
            );
            break;
          case "step-failed":
            console.log(` FAILED: ${event.error.message}`);
            break;
          case "review-rejected":
            console.log(
              `  [review] Rejected — looping back to ${event.loopingBackTo} (iteration ${event.step.iteration + 1})`,
            );
            break;
          case "confidence-escalation":
            console.log(
              `  [confidence] ${event.action} (${event.confidence.toFixed(2)})`,
            );
            break;
          case "model-fallback":
            console.log(
              `  [fallback] ${event.originalModel} → ${event.fallbackModel}: ${event.reason}`,
            );
            break;
          case "workflow-completed":
            console.log(
              `\n  Workflow complete. Total cost: $${event.run.totalCost.toFixed(4)}`,
            );
            console.log(
              `  Artifacts: ${event.run.artifacts.map((a) => a.id).join(", ")}\n`,
            );
            break;
          case "workflow-failed":
            console.log(`\n  Workflow failed: ${event.error.message}\n`);
            break;
        }
      }
    });

  // ── Run Command ────────────────────────────────────────────────────
}
