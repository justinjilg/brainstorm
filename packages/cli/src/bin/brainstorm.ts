import { Command } from 'commander';
import { loadConfig } from '@brainstorm/config';
import { getDb, closeDb } from '@brainstorm/db';
import { createProviderRegistry, getBrainstormApiKey, isCommunityKey } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry, configureSandbox } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt, buildToolAwarenessSection, SessionManager, PermissionManager, createSubagentTool, spawnSubagent, type CompactionCallbacks } from '@brainstorm/core';
import type { OutputStyle } from '@brainstorm/core';
import { AgentManager, parseAgentNL } from '@brainstorm/agents';
import { runWorkflow, getPresetWorkflow, autoSelectPreset, PRESET_WORKFLOWS } from '@brainstorm/workflow';
import { renderMarkdownToString } from '../components/MarkdownRenderer.js';
import { runInit } from '../init/index.js';
import { runEvalCli, runProbe } from '@brainstorm/eval';
import { createGatewayClient, formatGatewayFeedback } from '@brainstorm/gateway';
import { MCPClientManager } from '@brainstorm/mcp';
import { BrainstormVault, KeyResolver } from '@brainstorm/vault';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedKeys } from '@brainstorm/providers';

/** Known API key names that providers need at startup. */
const PROVIDER_KEY_NAMES = [
  'BRAINSTORM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'DEEPSEEK_API_KEY',
  'BRAINSTORM_ADMIN_KEY',
];

/**
 * Eagerly resolve all provider keys through the vault/1Password/env chain.
 * Triggers the lazy vault password prompt if a vault exists and keys are needed.
 * Returns a sync ResolvedKeys map for createProviderRegistry.
 */
async function resolveProviderKeys(): Promise<ResolvedKeys> {
  const vault = new BrainstormVault(VAULT_PATH);
  const resolver = new KeyResolver(
    vault.exists() ? vault : null,
    () => promptPassword('  Vault password: '),
  );

  const resolved = new Map<string, string>();
  for (const name of PROVIDER_KEY_NAMES) {
    const value = await resolver.get(name);
    if (value) resolved.set(name, value);
  }

  return { get: (name: string) => resolved.get(name) ?? null };
}

function buildCompactionCallbacks(sessionManager: SessionManager): CompactionCallbacks {
  return {
    getTokenEstimate: () => sessionManager.getTokenEstimate(),
    compact: (opts) => sessionManager.compact(opts),
  };
}

/**
 * Connect to MCP servers from config + BrainstormRouter gateway.
 * Loads user-configured servers from config.mcp.servers (populated from
 * config.toml and .brainstorm/mcp.json), plus the built-in gateway server.
 */
async function connectMCPServers(
  tools: ReturnType<typeof createDefaultToolRegistry>,
  config: ReturnType<typeof loadConfig>,
  resolvedBRKey?: string | null,
): Promise<void> {
  const mcp = new MCPClientManager();

  // User-configured MCP servers from config.toml / .brainstorm/mcp.json
  if (config.mcp.servers.length > 0) {
    mcp.addServers(config.mcp.servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      url: s.url ?? '',
      command: s.command,
      args: s.args,
      env: s.env,
      enabled: s.enabled,
      toolFilter: s.toolFilter,
    })));
  }

  // BrainstormRouter intelligence tools are now built-in natively
  // (br_status, br_budget, br_leaderboard, etc.) — no MCP needed.
  // MCP connection disabled to avoid schema compatibility issues.

  const { connected, errors } = await mcp.connectAll(tools);
  if (connected.length > 0) {
    process.stderr.write(`[mcp] Connected: ${connected.join(', ')}\n`);
  }
  for (const err of errors) {
    process.stderr.write(`[mcp] ${err.name}: ${err.error}\n`);
  }
}

const program = new Command();

program
  .name('brainstorm')
  .description('AI coding assistant with intelligent model routing')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize project for AI-assisted development')
  .option('--yes', 'Use defaults, skip prompts')
  .option('--force', 'Overwrite existing files')
  .action(async (opts: { yes?: boolean; force?: boolean }) => {
    await runInit(process.cwd(), opts);
  });

program
  .command('eval')
  .description('Run capability evaluation probes against a model')
  .option('--model <id>', 'Model to evaluate (e.g., anthropic/claude-sonnet-4-6)')
  .option('--capability <dim>', 'Run only probes for this dimension')
  .option('--compare', 'Compare results across all previously evaluated models')
  .option('--scorecard', 'Show current capability scores without re-running probes')
  .option('--all-models', 'Run probes against every available model')
  .option('--timeout <ms>', 'Timeout per probe in milliseconds', '30000')
  .action(async (opts: { model?: string; capability?: string; compare?: boolean; scorecard?: boolean; allModels?: boolean; timeout?: string }) => {
    await runEvalCli({
      model: opts.model,
      capability: opts.capability,
      compare: opts.compare,
      scorecard: opts.scorecard,
      allModels: opts.allModels,
      timeout: parseInt(opts.timeout ?? '30000'),
    });
  });

// ── Router Commands (BrainstormRouter Gateway) ───────────────────

const routerCmd = program.command('router').description('Manage BrainstormRouter gateway');

routerCmd
  .command('status')
  .description('Show gateway health, budget, and rate limits')
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set. Configure with: export BRAINSTORM_API_KEY=br_live_xxx'); return; }
    try {
      const [self, health] = await Promise.all([gw.getSelf(), gw.getHealth()]);
      console.log('\n  BrainstormRouter Gateway\n');
      console.log(`  Health:  ${health.status}`);
      console.log(`  Role:    ${self.identity.roles.join(', ')}`);
      console.log(`  Caps:    ${self.capabilities.granted.length} permissions`);
      try {
        const discovery = await gw.getDiscovery();
        if (discovery.budget) {
          console.log(`  Budget:  $${discovery.budget.remaining_usd?.toFixed(2)} / $${discovery.budget.limit_usd?.toFixed(2)} (${discovery.budget.period})`);
        }
        if (discovery.models) {
          console.log(`  Models:  ${discovery.models.available} available, ${discovery.models.runnable} runnable`);
        }
      } catch {
        console.log('  Budget:  (discovery unavailable)');
        console.log('  Models:  (discovery unavailable)');
      }
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('models')
  .description('List models available through the gateway')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      const models = await gw.listModels();
      if (opts.json) { console.log(JSON.stringify(models, null, 2)); return; }
      console.log(`\n  Gateway Models (${models.length})\n`);
      for (const m of models.slice(0, 30)) {
        const name = (m.name ?? m.id).padEnd(40);
        const provider = (m.provider ?? '').padEnd(12);
        console.log(`    ${provider} ${name}`);
      }
      if (models.length > 30) console.log(`    ... and ${models.length - 30} more`);
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('budget')
  .description('Show gateway-side cost tracking and forecast')
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      const usage = await gw.getUsageSummary();
      console.log('\n  Gateway Budget\n');
      console.log(`  Requests: ${usage.total_requests ?? 'N/A'}`);
      console.log(`  Cost:     $${(usage.total_cost_usd ?? 0).toFixed(4)}`);
      console.log(`  Tokens:   ${(usage.total_input_tokens ?? 0).toLocaleString()} in / ${(usage.total_output_tokens ?? 0).toLocaleString()} out`);
      if (usage.by_model?.length > 0) {
        console.log('\n  By model:');
        for (const m of usage.by_model) {
          console.log(`    ${m.model}: $${m.cost_usd.toFixed(4)} (${m.requests} reqs)`);
        }
      }
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('keys')
  .description('List API keys')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      const keys = await gw.listKeys();
      if (opts.json) { console.log(JSON.stringify(keys, null, 2)); return; }
      console.log(`\n  API Keys (${keys.length})\n`);
      for (const k of keys) {
        const budget = k.budgetLimitUsd ? `$${k.budgetLimitUsd}/${k.budgetPeriod}` : 'unlimited';
        console.log(`    ${k.id.slice(0, 8)}  ${(k.name ?? '').padEnd(30)} scopes=${JSON.stringify(k.scopes)}  budget=${budget}`);
      }
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('config')
  .description('Get or set gateway configuration')
  .argument('<key>', 'Config key (e.g., guardrails, tools)')
  .argument('[value]', 'JSON value to set (omit to read)')
  .action(async (key: string, value?: string) => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      if (value) {
        await gw.setConfig(key, JSON.parse(value));
        console.log(`  Set config/${key}`);
      } else {
        const data = await gw.getConfig(key);
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('audit')
  .description('Show recent request audit trail')
  .option('--since <duration>', 'Time range (e.g., 1h, 24h, 7d)', '24h')
  .action(async (opts: { since: string }) => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      const entries = await gw.getCompletionAudit(opts.since);
      console.log(`\n  Audit Trail (last ${opts.since})\n`);
      if (entries.length === 0) { console.log('    No entries found.'); }
      for (const e of entries.slice(0, 20)) {
        console.log(`    ${e.timestamp}  ${(e.model ?? '').padEnd(35)}  $${(e.cost_usd ?? 0).toFixed(4)}  ${e.latency_ms ?? '?'}ms  guardian=${e.guardian_status ?? '?'}`);
      }
      if (entries.length > 20) console.log(`    ... ${entries.length - 20} more`);
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

routerCmd
  .command('memory')
  .description('List gateway memory entries')
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) { console.error('  BRAINSTORM_API_KEY not set.'); return; }
    try {
      const entries = await gw.listMemory();
      console.log(`\n  Gateway Memory (${entries.length} entries)\n`);
      for (const e of entries) {
        const block = e.block ?? 'unknown';
        const content = e.content ?? JSON.stringify(e).slice(0, 80);
        console.log(`    [${block}] ${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`);
      }
      console.log();
    } catch (e: any) { console.error(`  Error: ${e.message}`); }
  });

// ── Models Command ────────────────────────────────────────────────

program
  .command('models')
  .description('List available models and their status')
  .action(async () => {
    const config = loadConfig();
    const registry = await createProviderRegistry(config, await resolveProviderKeys());

    console.log('\n🧠 Brainstorm — Available Models\n');

    const local = registry.models.filter((m) => m.isLocal);
    const cloud = registry.models.filter((m) => !m.isLocal);

    if (local.length > 0) {
      console.log('  Local Models:');
      for (const m of local) {
        const status = m.status === 'available' ? '●' : '○';
        console.log(`    ${status} ${m.id}  (quality: ${m.capabilities.qualityTier}, speed: ${m.capabilities.speedTier})`);
      }
      console.log();
    } else {
      console.log('  Local Models: none detected (start Ollama, LM Studio, or llama.cpp)\n');
    }

    console.log('  Cloud Models (via AI Gateway):');
    for (const m of cloud) {
      const cost = `$${m.pricing.inputPer1MTokens}/${m.pricing.outputPer1MTokens} per 1M tokens`;
      console.log(`    ● ${m.id}  (quality: ${m.capabilities.qualityTier}, ${cost})`);
    }
    console.log();
  });

program
  .command('budget')
  .description('Show cost tracking and budget status')
  .action(async () => {
    const config = loadConfig();
    const db = getDb();
    const costTracker = new CostTracker(db, config.budget);
    const summary = costTracker.getSummary();

    console.log('\n🧠 Brainstorm — Budget Status\n');
    console.log(`  Session:    $${summary.session.toFixed(4)}`);
    console.log(`  Today:      $${summary.today.toFixed(4)}${config.budget.daily ? ` / $${config.budget.daily.toFixed(2)}` : ''}`);
    console.log(`  This month: $${summary.thisMonth.toFixed(4)}${config.budget.monthly ? ` / $${config.budget.monthly.toFixed(2)}` : ''}`);

    if (summary.byModel.length > 0) {
      console.log('\n  Cost by model:');
      for (const entry of summary.byModel) {
        console.log(`    ${entry.modelId}: $${entry.totalCost.toFixed(4)} (${entry.requestCount} requests)`);
      }
    }
    console.log();
  });

program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const config = loadConfig();
    console.log('\n🧠 Brainstorm — Configuration\n');
    console.log(`  Strategy:     ${config.general.defaultStrategy}`);
    console.log(`  Max steps:    ${config.general.maxSteps}`);
    console.log(`  Confirm tools: ${config.general.confirmTools}`);
    console.log(`  Budget daily: ${config.budget.daily ? `$${config.budget.daily}` : 'unlimited'}`);
    console.log(`  Budget monthly: ${config.budget.monthly ? `$${config.budget.monthly}` : 'unlimited'}`);
    console.log(`  Hard limit:   ${config.budget.hardLimit}`);
    console.log(`  Ollama:       ${config.providers.ollama.enabled ? config.providers.ollama.baseUrl : 'disabled'}`);
    console.log(`  LM Studio:    ${config.providers.lmstudio.enabled ? config.providers.lmstudio.baseUrl : 'disabled'}`);
    console.log(`  llama.cpp:    ${config.providers.llamacpp.enabled ? config.providers.llamacpp.baseUrl : 'disabled'}`);
    console.log(`  AI Gateway:   ${config.providers.gateway.enabled ? 'enabled' : 'disabled'}`);
    if (config.routing.rules.length > 0) {
      console.log(`  Routing rules: ${config.routing.rules.length}`);
    }
    console.log();
  });

// ── Agent Commands ─────────────────────────────────────────────────

const agentCmd = program.command('agent').description('Manage named agents');

agentCmd
  .command('create')
  .description('Create an agent (structured flags or natural language)')
  .argument('[description...]', 'Natural language description (e.g., "architect using opus with $30 budget")')
  .option('--id <id>', 'Agent ID')
  .option('--model <model>', 'Model ID or alias')
  .option('--role <role>', 'Agent role (architect|coder|reviewer|debugger|analyst|custom)')
  .option('--budget <usd>', 'Per-workflow budget in USD', parseFloat)
  .option('--budget-daily <usd>', 'Daily budget in USD', parseFloat)
  .option('--description <desc>', 'What this agent does')
  .option('--confidence <threshold>', 'Confidence threshold 0-1', parseFloat)
  .action(async (descWords: string[], opts: any) => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);

    // Try natural language first
    const nlInput = descWords.join(' ');
    const parsed = nlInput ? parseAgentNL(nlInput) : null;

    const id = opts.id ?? parsed?.id ?? 'agent-' + Date.now().toString(36);
    const role = opts.role ?? parsed?.role ?? 'custom';
    const modelId = opts.model ?? parsed?.modelId ?? 'auto';
    const budget = opts.budget ?? parsed?.budget;
    const budgetDaily = opts.budgetDaily ?? parsed?.budgetDaily;
    const description = opts.description ?? parsed?.description ?? '';
    const confidence = opts.confidence ?? 0.7;

    const agent = manager.create({
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      role,
      description,
      modelId,
      allowedTools: role === 'coder' ? 'all' : ['file_read', 'glob', 'grep'],
      budget: {
        perWorkflow: budget,
        daily: budgetDaily,
        exhaustionAction: 'downgrade',
      },
      confidenceThreshold: confidence,
      maxSteps: 10,
      fallbackChain: [],
      guardrails: { pii: parsed?.guardrailsPii },
      lifecycle: 'active',
    });

    console.log(`\n  Created agent '${agent.id}'`);
    console.log(`    Role: ${agent.role}`);
    console.log(`    Model: ${agent.modelId}`);
    if (agent.budget.perWorkflow) console.log(`    Budget: $${agent.budget.perWorkflow}/workflow`);
    if (agent.budget.daily) console.log(`    Daily: $${agent.budget.daily}/day`);
    if (agent.guardrails.pii) console.log(`    Guardrails: PII enabled`);
    console.log();
  });

agentCmd
  .command('list')
  .description('List all agents')
  .action(async () => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);
    const agents = manager.list();

    console.log('\n  Agents:\n');
    if (agents.length === 0) {
      console.log('    No agents defined. Create one with: storm agent create <description>');
    }
    for (const a of agents) {
      const budget = a.budget.perWorkflow ? `$${a.budget.perWorkflow}/wf` : a.budget.daily ? `$${a.budget.daily}/day` : 'unlimited';
      console.log(`    ${a.id}  (${a.role})  model: ${a.modelId}  budget: ${budget}`);
    }
    console.log();
  });

agentCmd
  .command('show')
  .description('Show agent details')
  .argument('<id>', 'Agent ID')
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
    console.log(`    Description: ${agent.description || '(none)'}`);
    console.log(`    Allowed Tools: ${JSON.stringify(agent.allowedTools)}`);
    console.log(`    Budget/Workflow: ${agent.budget.perWorkflow ? `$${agent.budget.perWorkflow}` : 'unlimited'}`);
    console.log(`    Budget/Daily: ${agent.budget.daily ? `$${agent.budget.daily}` : 'unlimited'}`);
    console.log(`    Confidence: ${agent.confidenceThreshold}`);
    console.log(`    Fallback Chain: ${agent.fallbackChain.length > 0 ? agent.fallbackChain.join(' → ') : '(none)'}`);
    console.log(`    Guardrails: PII=${agent.guardrails.pii ?? false}`);
    console.log(`    Status: ${agent.lifecycle}`);
    console.log();
  });

agentCmd
  .command('delete')
  .description('Delete an agent')
  .argument('<id>', 'Agent ID')
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

// ── Workflow Commands ──────────────────────────────────────────────

const workflowCmd = program.command('workflow').description('Run multi-agent workflows');

workflowCmd
  .command('list')
  .description('List available workflows')
  .action(async () => {
    console.log('\n  Workflows:\n');
    for (const w of PRESET_WORKFLOWS) {
      const steps = w.steps.map((s) => s.agentRole).join(' → ');
      console.log(`    ${w.id}  — ${w.description}`);
      console.log(`      Steps: ${steps}  (mode: ${w.communicationMode}, max loops: ${w.maxIterations})`);
    }
    console.log();
  });

workflowCmd
  .command('run')
  .description('Run a workflow')
  .argument('<preset>', 'Workflow preset ID or natural language description')
  .argument('[description...]', 'What to build/fix/review')
  .option('--agents <mapping>', 'Agent role overrides (e.g., "architect=my-arch,coder=my-coder")')
  .option('--mode <mode>', 'Communication mode (handoff|shared)', 'handoff')
  .option('--dry-run', 'Show cost forecast only')
  .action(async (preset: string, descWords: string[], opts: any) => {
    const description = descWords.join(' ') || preset;

    // Resolve workflow
    let workflow = getPresetWorkflow(preset);
    if (!workflow) {
      const autoPreset = autoSelectPreset(preset + ' ' + description);
      if (autoPreset) workflow = getPresetWorkflow(autoPreset);
    }
    if (!workflow) {
      console.error(`  Unknown workflow: '${preset}'. Run 'storm workflow list' to see available workflows.`);
      process.exit(1);
    }

    const config = loadConfig();
    const db = getDb();
    const registry = await createProviderRegistry(config, await resolveProviderKeys());
    const costTracker = new CostTracker(db, config.budget);
    const projectPath = process.cwd();
    const { frontmatter } = buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(config, registry, costTracker, frontmatter);
    const agentManager = new AgentManager(db, config);

    // Parse agent overrides
    const agentOverrides: Record<string, string> = {};
    if (opts.agents) {
      for (const pair of opts.agents.split(',')) {
        const [role, agentId] = pair.split('=');
        if (role && agentId) agentOverrides[role.trim()] = agentId.trim();
      }
    }

    console.log(`\n  Workflow: ${workflow.name}`);
    console.log(`  Request: "${description}"`);
    console.log(`  Steps: ${workflow.steps.map((s) => s.agentRole).join(' → ')}\n`);

    for await (const event of runWorkflow(workflow, description, agentOverrides, {
      config, db, registry, router, costTracker, agentManager, projectPath,
    })) {
      switch (event.type) {
        case 'cost-forecast':
          console.log(`  Estimated cost: $${event.estimated.toFixed(4)}`);
          for (const b of event.breakdown) {
            console.log(`    ${b.step}: $${b.cost.toFixed(4)}`);
          }
          if (opts.dryRun) {
            console.log('\n  (dry run — not executing)\n');
            return;
          }
          console.log();
          break;
        case 'step-started':
          process.stdout.write(`  [${event.agent.role}] ${event.agent.displayName} (${event.agent.modelId})...`);
          break;
        case 'step-progress':
          if (event.event.type === 'text-delta') {
            // Don't flood output — just show dots for progress
          }
          if (event.event.type === 'routing') {
            process.stdout.write(` → ${event.event.decision.model.name}`);
          }
          break;
        case 'step-completed':
          console.log(` done ($${event.step.cost.toFixed(4)}, confidence: ${event.artifact.confidence.toFixed(2)})`);
          break;
        case 'step-failed':
          console.log(` FAILED: ${event.error.message}`);
          break;
        case 'review-rejected':
          console.log(`  [review] Rejected — looping back to ${event.loopingBackTo} (iteration ${event.step.iteration + 1})`);
          break;
        case 'confidence-escalation':
          console.log(`  [confidence] ${event.action} (${event.confidence.toFixed(2)})`);
          break;
        case 'model-fallback':
          console.log(`  [fallback] ${event.originalModel} → ${event.fallbackModel}: ${event.reason}`);
          break;
        case 'workflow-completed':
          console.log(`\n  Workflow complete. Total cost: $${event.run.totalCost.toFixed(4)}`);
          console.log(`  Artifacts: ${event.run.artifacts.map((a) => a.id).join(', ')}\n`);
          break;
        case 'workflow-failed':
          console.log(`\n  Workflow failed: ${event.error.message}\n`);
          break;
      }
    }
  });

// ── Run Command ────────────────────────────────────────────────────

program
  .command('run')
  .description('Run a single prompt non-interactively')
  .argument('[prompt]', 'The prompt to send')
  .option('--json', 'Output structured JSON (for CI/CD pipelines)')
  .option('--pipe', 'Read from stdin if no prompt given')
  .option('--model <id>', 'Target a specific model (bypass routing)')
  .option('--tools', 'Enable tool use (default: disabled)')
  .option('--max-steps <n>', 'Maximum agentic steps (default: 1)', '1')
  .option('--strategy <name>', 'Routing strategy: cost-first, quality-first, combined, capability')
  .option('--lfg', 'Full auto mode — skip all permission confirmations')
  .action(async (prompt: string | undefined, opts: { json?: boolean; pipe?: boolean; model?: string; tools?: boolean; maxSteps?: string; strategy?: string; lfg?: boolean }) => {
    // Handle --pipe: read prompt from stdin
    let finalPrompt = prompt;
    if (opts.pipe) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const stdinText = Buffer.concat(chunks).toString('utf-8').trim();
      if (finalPrompt) {
        // Append stdin to prompt argument
        finalPrompt = `${finalPrompt}\n\n${stdinText}`;
      } else {
        finalPrompt = stdinText;
      }
    }
    if (!finalPrompt) {
      process.stderr.write('Error: No prompt provided. Pass a prompt argument or use --pipe to read from stdin.\n');
      process.exit(1);
    }

    const config = loadConfig();

    // --lfg: full auto mode, skip all permission confirmations
    if (opts.lfg) {
      config.general.defaultPermissionMode = 'auto';
    }

    const db = getDb();
    const resolvedKeys = await resolveProviderKeys();
    const resolvedBRKey = resolvedKeys.get('BRAINSTORM_API_KEY') ?? getBrainstormApiKey();
    const isCommunityTier = isCommunityKey(resolvedBRKey);
    // Set env for native BR tools (br_status, br_budget, etc.)
    if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;
    const registry = await createProviderRegistry(config, resolvedKeys);
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    await connectMCPServers(tools, config, resolvedKeys.get('BRAINSTORM_API_KEY'));
    const sessionManager = new SessionManager(db);
    const projectPath = process.cwd();
    configureSandbox(config.shell.sandbox as any, projectPath);
    const { prompt: rawPrompt, frontmatter } = buildSystemPrompt(projectPath);
    const systemPrompt = rawPrompt + buildToolAwarenessSection(tools.listTools());
    const router = new BrainstormRouter(config, registry, costTracker, frontmatter);

    // Permission manager — gates tool execution
    const permissionManager = new PermissionManager(
      config.general.defaultPermissionMode as any,
      config.permissions,
    );

    // Strategy: CLI flag → paid-key default → config default
    if (opts.strategy) {
      router.setStrategy(opts.strategy as any);
    } else if (!isCommunityTier) {
      router.setStrategy('quality-first');
    }

    const session = sessionManager.start(projectPath);

    sessionManager.addUserMessage(finalPrompt);

    let fullResponse = '';
    let modelName = 'unknown';
    let toolCallCount = 0;

    if (!opts.json) {
      process.stdout.write('\n');
    }

    for await (const event of runAgentLoop(sessionManager.getHistory(), {
      config, registry, router, costTracker, tools,
      sessionId: session.id, projectPath, systemPrompt,
      disableTools: !opts.tools,
      preferredModelId: opts.model ?? (isCommunityTier ? 'brainstormrouter/auto' : undefined),
      maxSteps: parseInt(opts.maxSteps ?? '1'),
      compaction: buildCompactionCallbacks(sessionManager),
      permissionCheck: (tool, args) => permissionManager.check(tool, args),
    })) {
      switch (event.type) {
        case 'thinking':
          if (!opts.json) {
            const phases: Record<string, string> = {
              classifying: 'Classifying task...',
              routing: 'Selecting model...',
              connecting: `Connecting...`,
              streaming: 'Streaming...',
            };
            process.stderr.write(`\r${phases[event.phase] ?? event.phase}`);
          }
          break;
        case 'routing':
          modelName = event.decision.model.name;
          process.stderr.write(`\r[${event.decision.strategy}] → ${modelName}\n`);
          break;
        case 'text-delta':
          fullResponse += event.delta;
          break;
        case 'tool-call-start':
          toolCallCount++;
          process.stderr.write(`\n[tool: ${event.toolName}]\n`);
          break;
        case 'gateway-feedback': {
          const gwLine = formatGatewayFeedback(event.feedback);
          if (gwLine) process.stderr.write(`${gwLine}\n`);
          break;
        }
        case 'model-retry':
          process.stderr.write(`\n[retry] ${event.fromModel} → ${event.toModel} (${event.reason})\n`);
          modelName = event.toModel;
          fullResponse = ''; // Reset for retry
          break;
        case 'done':
          if (opts.json) {
            // Structured JSON output for CI/CD — only valid JSON on stdout
            process.stdout.write(JSON.stringify({
              text: fullResponse,
              model: modelName,
              cost: event.totalCost,
              toolCalls: toolCallCount,
              success: true,
            }) + '\n');
          } else {
            process.stdout.write(renderMarkdownToString(fullResponse));
            process.stdout.write(`\n\n[cost: $${event.totalCost.toFixed(4)}]\n`);
          }
          break;
        case 'error':
          if (opts.json) {
            process.stdout.write(JSON.stringify({ text: '', model: modelName, cost: 0, toolCalls: toolCallCount, error: event.error.message, success: false }) + '\n');
            process.exit(1);
          } else {
            process.stderr.write(`\nError: ${event.error.message}\n`);
          }
          break;
      }
    }

    if (fullResponse) {
      sessionManager.addAssistantMessage(fullResponse);
    }
  });

// ── Probe Command ─────────────────────────────────────────────────

program
  .command('probe')
  .description('Run an ad-hoc eval probe with verification (for autonomous testing)')
  .argument('<prompt>', 'The prompt to test')
  .option('--model <id>', 'Target a specific model')
  .option('--expect-tools <tools>', 'Comma-separated tool names that must be called')
  .option('--expect-contains <strings>', 'Comma-separated strings that must appear in output')
  .option('--expect-excludes <strings>', 'Comma-separated strings that must NOT appear')
  .option('--min-steps <n>', 'Minimum number of agentic steps')
  .option('--max-steps <n>', 'Maximum number of agentic steps', '10')
  .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
  .option('--json', 'Output full ProbeResult as JSON')
  .option('--setup-file <pairs...>', 'Setup files as path=content pairs')
  .action(async (prompt: string, opts: any) => {
    // Build Probe from CLI args
    const probe: any = {
      id: `adhoc-${Date.now().toString(36)}`,
      capability: 'multi-step' as const,
      prompt,
      verify: {},
      timeout_ms: parseInt(opts.timeout),
    };

    if (opts.expectTools) {
      probe.verify.tool_calls_include = opts.expectTools.split(',').map((s: string) => s.trim());
    }
    if (opts.expectContains) {
      probe.verify.answer_contains = opts.expectContains.split(',').map((s: string) => s.trim());
    }
    if (opts.expectExcludes) {
      probe.verify.answer_excludes = opts.expectExcludes.split(',').map((s: string) => s.trim());
    }
    if (opts.minSteps) {
      probe.verify.min_steps = parseInt(opts.minSteps);
    }
    if (opts.maxSteps) {
      probe.verify.max_steps = parseInt(opts.maxSteps);
    }

    // Parse setup files: --setup-file "path=content" --setup-file "path2=content2"
    if (opts.setupFile) {
      probe.setup = { files: {} as Record<string, string> };
      for (const pair of opts.setupFile) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          probe.setup.files[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }

    const result = await runProbe(probe, {
      modelId: opts.model,
      maxSteps: parseInt(opts.maxSteps),
      defaultTimeout: parseInt(opts.timeout),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const status = result.passed ? 'PASSED' : 'FAILED';
      console.log(`\n  Probe: ${status}`);
      console.log(`  Model: ${result.modelId}`);
      console.log(`  Steps: ${result.steps}`);
      console.log(`  Cost:  $${result.cost.toFixed(4)}`);
      console.log(`  Time:  ${result.durationMs}ms`);
      if (result.toolCalls.length > 0) {
        console.log(`  Tools: ${result.toolCalls.map((t) => t.name).join(', ')}`);
      }
      if (!result.passed) {
        const failures = result.checks.filter((c) => !c.passed);
        console.log(`  Failures:`);
        for (const f of failures) {
          console.log(`    - ${f.check}: ${f.detail ?? 'failed'}`);
        }
      }
      if (result.error) console.log(`  Error: ${result.error}`);
      console.log(`  Output: ${result.output.slice(0, 200)}${result.output.length > 200 ? '...' : ''}`);
      console.log();
    }

    process.exit(result.passed ? 0 : 1);
  });

// ── Vault Commands ─────────────────────────────────────────────────

const VAULT_PATH = join(homedir(), '.brainstorm', 'vault.enc');

/** Prompt for a password with masked echo. Supports BRAINSTORM_VAULT_PASSWORD env for non-interactive use. */
function promptPassword(prompt: string): Promise<string> {
  // Non-interactive: use env var if set (for CI/CD and scripting)
  const envPassword = process.env.BRAINSTORM_VAULT_PASSWORD;
  if (envPassword) return Promise.resolve(envPassword);

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(prompt);
    // Disable echo
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    let password = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r' || c === '\u0004') {
        if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        rl.close();
        resolve(password);
      } else if (c === '\u0003') {
        if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        reject(new Error('Cancelled'));
      } else if (c === '\u007F' || c === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write('\b \b'); // Erase the * character
        }
      } else {
        password += c;
        process.stderr.write('*'); // Show * for each character typed
      }
    };
    process.stdin.on('data', onData);
  });
}

const vaultCmd = program.command('vault').description('Manage encrypted key vault');

vaultCmd
  .command('init')
  .description('Create a new encrypted vault')
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    if (vault.exists()) {
      console.error('  Vault already exists. Use `brainstorm vault rotate` to change password.');
      process.exit(1);
    }
    const password = await promptPassword('  Master password: ');
    const confirm = await promptPassword('  Confirm password: ');
    if (password !== confirm) {
      console.error('  Passwords do not match.');
      process.exit(1);
    }
    if (password.length < 8) {
      console.error('  Password must be at least 8 characters.');
      process.exit(1);
    }
    await vault.init(password);
    console.log(`  Vault created at ${VAULT_PATH}`);
  });

vaultCmd
  .command('add <name>')
  .description('Add a key to the vault')
  .argument('[value]', 'Key value (prompted if omitted)')
  .action(async (name: string, value?: string) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword('  Master password: ');
    vault.open(password);
    const keyValue = value ?? await promptPassword(`  Value for ${name}: `);
    vault.set(name, keyValue);
    vault.seal();
    console.log(`  Added ${name} to vault.`);
  });

vaultCmd
  .command('list')
  .description('List stored key names')
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    if (!vault.exists()) {
      console.log('  No vault found. Run `brainstorm vault init` first.');
      return;
    }
    const password = await promptPassword('  Master password: ');
    vault.open(password);
    const keys = vault.list();
    if (keys.length === 0) {
      console.log('  Vault is empty.');
    } else {
      console.log(`\n  Keys (${keys.length}):\n`);
      for (const k of keys) console.log(`    ${k}`);
      console.log();
    }
  });

vaultCmd
  .command('get <name>')
  .description('Show a key value')
  .action(async (name: string) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword('  Master password: ');
    vault.open(password);
    const value = vault.get(name);
    if (value) {
      console.log(value);
    } else {
      console.error(`  Key "${name}" not found in vault.`);
      process.exit(1);
    }
  });

vaultCmd
  .command('remove <name>')
  .description('Remove a key from the vault')
  .action(async (name: string) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword('  Master password: ');
    vault.open(password);
    if (vault.delete(name)) {
      vault.seal();
      console.log(`  Removed ${name} from vault.`);
    } else {
      console.error(`  Key "${name}" not found in vault.`);
      process.exit(1);
    }
  });

vaultCmd
  .command('rotate')
  .description('Change vault master password')
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    const current = await promptPassword('  Current password: ');
    vault.open(current);
    const newPass = await promptPassword('  New password: ');
    const confirm = await promptPassword('  Confirm new password: ');
    if (newPass !== confirm) {
      console.error('  Passwords do not match.');
      process.exit(1);
    }
    if (newPass.length < 8) {
      console.error('  Password must be at least 8 characters.');
      process.exit(1);
    }
    vault.rotate(newPass);
    console.log('  Vault password rotated.');
  });

vaultCmd
  .command('lock')
  .description('Clear vault keys from memory')
  .action(() => {
    console.log('  Vault locked (keys cleared from memory).');
  });

vaultCmd
  .command('status')
  .description('Show vault and backend status')
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    const resolver = new KeyResolver(vault.exists() ? vault : null);
    const s = resolver.status();
    console.log('\n  Vault Status:\n');
    console.log(`    Vault:      ${s.vault}`);
    console.log(`    1Password:  ${s.op}`);
    console.log(`    Env vars:   ${s.env}`);
    console.log(`    Priority:   vault → 1Password → env vars\n`);
  });

// ── Sessions Command ───────────────────────────────────────────────

program
  .command('sessions')
  .description('List recent chat sessions')
  .option('-n, --limit <count>', 'Number of sessions to show', '10')
  .action(async (opts: { limit: string }) => {
    const db = getDb();
    const sessionManager = new SessionManager(db);
    const sessions = sessionManager.listRecent(parseInt(opts.limit));

    console.log('\n  Recent Sessions:\n');
    if (sessions.length === 0) {
      console.log('    No sessions found.');
    }
    for (const s of sessions) {
      const age = Math.floor((Date.now() / 1000 - s.updatedAt) / 60);
      const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`;
      console.log(`    ${s.id.slice(0, 8)}  ${s.messageCount} msgs  $${s.totalCost.toFixed(4)}  ${ageStr}  ${s.projectPath}`);
    }
    console.log();
  });

// ── Chat Command ──────────────────────────────────────────────────

program
  .command('chat', { isDefault: true })
  .description('Start an interactive chat session')
  .option('--simple', 'Use simple readline interface instead of TUI')
  .option('--continue', 'Resume the most recent session')
  .option('--resume <id>', 'Resume a specific session by ID')
  .option('--fork <id>', 'Fork a session (copy history, new session)')
  .option('--lfg', 'Full auto mode — skip all permission confirmations')
  .option('--strategy <name>', 'Routing strategy: cost-first, quality-first, combined, capability')
  .action(async (opts: { simple?: boolean; continue?: boolean; resume?: string; fork?: string; lfg?: boolean; strategy?: string }) => {
    const config = loadConfig();

    // --lfg: full auto mode, skip all permission confirmations
    if (opts.lfg) {
      config.general.defaultPermissionMode = 'auto';
    }

    const db = getDb();
    const resolvedKeys = await resolveProviderKeys();
    const resolvedBRKey = resolvedKeys.get('BRAINSTORM_API_KEY') ?? getBrainstormApiKey();
    const isCommunityTier = isCommunityKey(resolvedBRKey);
    // Set env for native BR tools (br_status, br_budget, etc.)
    if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;
    const registry = await createProviderRegistry(config, resolvedKeys);
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    await connectMCPServers(tools, config, resolvedKeys.get('BRAINSTORM_API_KEY'));
    const projectPath = process.cwd();
    configureSandbox(config.shell.sandbox as any, projectPath);

    // Permission manager — gates tool execution
    const permissionManager = new PermissionManager(
      config.general.defaultPermissionMode as any,
      config.permissions,
    );

    // Output style — mutable so /style can change it mid-session
    let currentOutputStyle: OutputStyle = (config.general.outputStyle as OutputStyle) ?? 'concise';

    const sessionManager = new SessionManager(db);
    let { prompt: systemPrompt, frontmatter } = buildSystemPrompt(projectPath, currentOutputStyle);
    systemPrompt += buildToolAwarenessSection(tools.listTools());
    const router = new BrainstormRouter(config, registry, costTracker, frontmatter);
    // Paid keys get quality-first by default — you're paying, use the good models.
    // Community tier stays on whatever BR's server-side routing picks (cost-first).
    if (opts.strategy) {
      router.setStrategy(opts.strategy as any);
    } else if (!isCommunityTier && router.getActiveStrategy() !== 'capability') {
      router.setStrategy('quality-first');
    }

    // Register the subagent tool (model can spawn focused subagents)
    const subagentTool = createSubagentTool({
      config, registry, router, costTracker, tools, projectPath,
      permissionCheck: (name, perm) => permissionManager.check(name, perm),
    });
    tools.register(subagentTool);

    // Preferred model override — mutable so /model can change it
    // Community tier: force brainstormrouter/auto so server-side routing picks allowed models
    let preferredModelId: string | undefined = isCommunityTier ? 'brainstormrouter/auto' : undefined;

    // Session management: resume, fork, or start new
    let session: any;
    if (opts.fork) {
      session = sessionManager.fork(opts.fork);
      if (!session) { console.error(`  Session '${opts.fork}' not found.`); process.exit(1); }
      console.log(`  Forked session ${opts.fork.slice(0, 8)} -> ${session.id.slice(0, 8)}`);
    } else if (opts.resume) {
      session = sessionManager.resume(opts.resume);
      if (!session) { console.error(`  Session '${opts.resume}' not found.`); process.exit(1); }
      console.log(`  Resumed session ${session.id.slice(0, 8)} (${session.messageCount} messages)`);
    } else if (opts.continue) {
      session = sessionManager.resumeLatest(projectPath);
      if (!session) { session = sessionManager.start(projectPath); }
      else { console.log(`  Continued session ${session.id.slice(0, 8)} (${session.messageCount} messages)`); }
    } else {
      session = sessionManager.start(projectPath);
    }

    const localCount = registry.models.filter((m) => m.isLocal).length;
    const cloudCount = registry.models.filter((m) => !m.isLocal).length;

    if (opts.simple) {
      // Simple readline fallback
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      console.log(`\n  🧠 brainstorm v0.1.0`);
      console.log(`  Strategy: ${router.getActiveStrategy()} | Models: ${localCount} local, ${cloudCount} cloud`);
      console.log(`  Project: ${projectPath}`);
      if (isCommunityTier) console.log(`  Community tier (5 req/min, cheap models). Set BRAINSTORM_API_KEY for full access.`);
      console.log(`  Commands: /quit, /model <id>, /strategy <name>, /compact`);
      console.log(`  Ctrl+C to interrupt, Ctrl+D to exit.\n`);

      let simpleAbortController: AbortController | null = null;

      // First Ctrl-C aborts current operation, second exits
      process.on('SIGINT', () => {
        if (simpleAbortController) {
          simpleAbortController.abort();
          simpleAbortController = null;
          process.stdout.write('\n  [interrupted]\n\n');
        } else {
          rl.close();
          process.exit(0);
        }
      });

      while (true) {
        const input = await rl.question('you > ');
        if (!input.trim()) continue;
        if (input.trim() === '/quit' || input.trim() === '/exit') break;

        // Handle slash commands in simple mode
        if (input.startsWith('/')) {
          const [cmd, ...args] = input.trim().split(/\s+/);
          const arg = args.join(' ');
          if (cmd === '/model') {
            if (!arg) { console.log('  Usage: /model <provider/model-id>'); continue; }
            preferredModelId = arg;
            console.log(`  Model set to: ${arg}`);
            continue;
          }
          if (cmd === '/strategy') {
            if (!arg) { console.log(`  Current: ${router.getActiveStrategy()}. Options: cost-first, quality-first, combined, capability`); continue; }
            router.setStrategy(arg as any);
            console.log(`  Strategy set to: ${arg}`);
            continue;
          }
          if (cmd === '/compact') {
            const result = await sessionManager.compact({ contextWindow: 200000, keepRecent: 5 });
            console.log(`  Compacted: ${result.removed} messages removed (${result.tokensBefore} → ${result.tokensAfter} tokens)`);
            continue;
          }
          if (cmd === '/clear') {
            session = sessionManager.start(projectPath);
            console.log('  Session cleared.');
            continue;
          }
          // Unknown slash command — pass to model as regular message
        }

        sessionManager.addUserMessage(input);
        let fullResponse = '';
        process.stdout.write('\nbrainstorm > ');
        simpleAbortController = new AbortController();

        for await (const event of runAgentLoop(sessionManager.getHistory(), {
          config, registry, router, costTracker, tools,
          sessionId: session.id, projectPath, systemPrompt,
          compaction: buildCompactionCallbacks(sessionManager),
          signal: simpleAbortController.signal,
          permissionCheck: (name, perm) => permissionManager.check(name, perm),
          preferredModelId,
          onTurnComplete: (ctx) => {
            ctx.turn = sessionManager.incrementTurn();
            ctx.sessionMinutes = sessionManager.getSessionMinutes();
            sessionManager.addTurnContext(ctx);
          },
        })) {
          switch (event.type) {
            case 'thinking':
              process.stderr.write(`\r  ${event.phase === 'classifying' ? 'Analyzing...' : event.phase === 'routing' ? 'Selecting model...' : event.phase === 'connecting' ? 'Connecting...' : 'Streaming...'}`);
              break;
            case 'routing':
              process.stderr.write(`\r  [${event.decision.model.name}]\n`);
              break;
            case 'text-delta':
              fullResponse += event.delta;
              process.stdout.write(event.delta);
              break;
            case 'tool-call-start':
              process.stdout.write(`\n  [tool: ${event.toolName}]\n`);
              break;
            case 'tool-call-result':
              break; // Tool results are shown by the model's text response
            case 'model-retry':
              process.stderr.write(`\n  [retry: ${event.fromModel} → ${event.toModel}]\n`);
              break;
            case 'gateway-feedback': {
              const gw = formatGatewayFeedback(event.feedback);
              if (gw) process.stderr.write(`  ${gw}\n`);
              break;
            }
            case 'context-budget':
              process.stderr.write(`  [${Math.round(event.used / 1000)}k/${Math.round(event.limit / 1000)}k tokens (${event.percent}%)]\n`);
              break;
            case 'interrupted':
              process.stdout.write('\n  [interrupted]\n\n');
              break;
            case 'done':
              process.stdout.write(`\n  [$${event.totalCost.toFixed(4)}]\n\n`);
              break;
            case 'error':
              process.stderr.write(`\n  Error: ${event.error.message}\n\n`);
              break;
          }
        }
        simpleAbortController = null;
        if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
      }
      rl.close();
      return;
    }

    // Ink TUI
    const { render } = await import('ink');
    const React = await import('react');
    const { ChatApp } = await import('../components/ChatApp.js');

    let currentAbortController: AbortController | null = null;

    function handleSendMessage(text: string) {
      sessionManager.addUserMessage(text);
      currentAbortController = new AbortController();
      const gen = runAgentLoop(sessionManager.getHistory(), {
        config, registry, router, costTracker, tools,
        sessionId: session.id, projectPath, systemPrompt,
        compaction: buildCompactionCallbacks(sessionManager),
        signal: currentAbortController.signal,
        permissionCheck: (name, perm) => permissionManager.check(name, perm),
        preferredModelId,
      });
      // Wrap to capture assistant message after completion
      return (async function* () {
        let fullResponse = '';
        for await (const event of gen) {
          if (event.type === 'text-delta') fullResponse += event.delta;
          yield event;
        }
        if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
        currentAbortController = null;
      })();
    }

    function handleAbort() {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    }

    render(
      React.createElement(ChatApp, {
        strategy: config.general.defaultStrategy,
        modelCount: { local: localCount, cloud: cloudCount },
        onSendMessage: handleSendMessage,
        onAbort: handleAbort,
        slashCallbacks: {
          setModel: (model: string) => { preferredModelId = model; },
          setStrategy: (s: string) => { router.setStrategy(s as any); },
          getStrategy: () => router.getActiveStrategy(),
          setMode: (mode: string) => { permissionManager.setMode(mode as any); },
          getMode: () => permissionManager.getMode(),
          setOutputStyle: (style: string) => {
            currentOutputStyle = style as OutputStyle;
            const rebuilt = buildSystemPrompt(projectPath, currentOutputStyle);
            systemPrompt = rebuilt.prompt + buildToolAwarenessSection(tools.listTools());
          },
          getOutputStyle: () => currentOutputStyle,
          getBudget: () => {
            const state = costTracker.getBudgetState();
            if (!state.sessionLimit) return null;
            return { remaining: Math.max(0, state.sessionLimit - state.sessionUsed), limit: state.sessionLimit };
          },
          compact: async () => {
            // Use the current model's context window, or fall back to 128k
            const models = router.getModels();
            const activeModel = preferredModelId
              ? models.find((m) => m.id === preferredModelId)
              : models[0];
            const contextWindow = activeModel?.limits?.contextWindow || 128_000;
            const cb = buildCompactionCallbacks(sessionManager);
            await cb.compact({ contextWindow });
          },
          dream: async () => {
            const { MemoryManager, DREAM_SYSTEM_PROMPT, buildDreamPrompt } = await import('@brainstorm/core');
            const memory = new MemoryManager(projectPath);
            const rawFiles = memory.getRawFiles();
            if (rawFiles.length === 0) return 'No memory files to consolidate.';
            const dreamPrompt = buildDreamPrompt(memory.getMemoryDir(), rawFiles);
            const result = await spawnSubagent(dreamPrompt, {
              config, registry, router, costTracker, tools, projectPath,
              type: 'code',
              systemPrompt: DREAM_SYSTEM_PROMPT,
              maxSteps: 12,
              budgetLimit: 0.50,
            });
            return `Dream complete. ${result.toolCalls.length} tool calls, $${result.cost.toFixed(4)}.\n${result.text}`;
          },
          vault: async (action: string, args: string) => {
            const vault = new BrainstormVault(VAULT_PATH);
            switch (action) {
              case 'list': case 'ls': {
                if (!vault.exists()) return 'No vault found. Run `brainstorm vault init` to create one.';
                const keys = vault.list();
                if (keys.length === 0) return 'Vault is empty (or locked). Keys: none';
                return `Vault keys (${keys.length}):\n${keys.map((k) => `  - ${k}`).join('\n')}`;
              }
              case 'status': {
                if (!vault.exists()) return 'Vault: not initialized';
                return `Vault: ${VAULT_PATH}\nStatus: ${vault.isOpen() ? 'unlocked' : 'locked'}\nKeys: ${vault.list().length}`;
              }
              case 'get': {
                if (!args) return 'Usage: /vault get <key-name>';
                const val = vault.get(args);
                if (val === null) return `Key '${args}' not found (or vault is locked).`;
                return `${args} = ${val.slice(0, 8)}${'*'.repeat(Math.max(0, val.length - 8))}`;
              }
              case 'add': case 'set': {
                return 'Use `brainstorm vault add <name>` from the terminal — requires interactive password input.';
              }
              case 'remove': case 'rm': case 'delete': {
                return 'Use `brainstorm vault remove <name>` from the terminal — requires interactive password input.';
              }
              default:
                return 'Usage: /vault [list|status|get <name>]\nFor add/remove, use the `brainstorm vault` CLI command.';
            }
          },
        },
      }),
    );
  });

export function run() {
  // Graceful shutdown: finalize session, close DB, kill background tasks
  const cleanup = () => {
    try {
      closeDb();
    } catch {
      // Best effort — DB may already be closed
    }
  };

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.on('exit', () => {
    cleanup();
  });

  program.parse();
}

run();
