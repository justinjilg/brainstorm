import { Command } from 'commander';
import { loadConfig } from '@brainstorm/config';
import { getDb } from '@brainstorm/db';
import { createProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt, SessionManager, type CompactionCallbacks } from '@brainstorm/core';
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

  // Built-in BrainstormRouter gateway MCP (if API key available)
  const brKey = process.env.BRAINSTORM_API_KEY;
  if (brKey) {
    mcp.addServers([{
      name: 'brainstormrouter',
      transport: 'stdio',
      url: 'brainstormrouter-mcp',
      command: 'npx',
      args: ['brainstormrouter-mcp'],
      env: { BRAINSTORM_API_KEY: brKey },
      toolFilter: [
        'br_get_ops_status', 'br_list_models', 'br_get_budget',
        'br_get_memory', 'br_store_memory', 'br_query_memory',
        'br_get_config', 'br_set_config', 'br_get_insights',
      ],
    }]);
  }

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
  .option('--timeout <ms>', 'Timeout per probe in milliseconds', '30000')
  .action(async (opts: { model?: string; capability?: string; compare?: boolean; timeout?: string }) => {
    await runEvalCli({
      model: opts.model,
      capability: opts.capability,
      compare: opts.compare,
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
  .argument('<prompt>', 'The prompt to send')
  .option('--json', 'Output structured JSON (for CI/CD pipelines)')
  .option('--pipe', 'Read from stdin if no prompt given')
  .option('--model <id>', 'Target a specific model (bypass routing)')
  .option('--tools', 'Enable tool use (default: disabled)')
  .option('--max-steps <n>', 'Maximum agentic steps (default: 1)', '1')
  .action(async (prompt: string, opts: { json?: boolean; pipe?: boolean; model?: string; tools?: boolean; maxSteps?: string }) => {
    const config = loadConfig();
    const db = getDb();
    const registry = await createProviderRegistry(config, await resolveProviderKeys());
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    await connectMCPServers(tools, config);
    const sessionManager = new SessionManager(db);
    const projectPath = process.cwd();
    const { prompt: systemPrompt, frontmatter } = buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(config, registry, costTracker, frontmatter);
    const session = sessionManager.start(projectPath);

    sessionManager.addUserMessage(prompt);

    let fullResponse = '';
    process.stdout.write('\n');

    for await (const event of runAgentLoop(sessionManager.getHistory(), {
      config, registry, router, costTracker, tools,
      sessionId: session.id, projectPath, systemPrompt,
      disableTools: !opts.tools,
      ...(opts.model ? { preferredModelId: opts.model } : {}),
      maxSteps: parseInt(opts.maxSteps ?? '1'),
      compaction: buildCompactionCallbacks(sessionManager),
    })) {
      switch (event.type) {
        case 'routing':
          process.stderr.write(`[${event.decision.strategy}] → ${event.decision.model.name}\n`);
          break;
        case 'text-delta':
          fullResponse += event.delta;
          break;
        case 'tool-call-start':
          process.stderr.write(`\n[tool: ${event.toolName}]\n`);
          break;
        case 'gateway-feedback': {
          const gwLine = formatGatewayFeedback(event.feedback);
          if (gwLine) process.stderr.write(`${gwLine}\n`);
          break;
        }
        case 'done':
          if (opts.json) {
            // Structured JSON output for CI/CD
            process.stdout.write(JSON.stringify({
              text: fullResponse,
              model: (event as any).model ?? 'unknown',
              cost: event.totalCost,
              success: true,
            }) + '\n');
          } else {
            process.stdout.write(renderMarkdownToString(fullResponse));
            process.stdout.write(`\n\n[cost: $${event.totalCost.toFixed(4)}]\n`);
          }
          break;
        case 'error':
          if (opts.json) {
            process.stdout.write(JSON.stringify({ text: '', error: event.error.message, success: false }) + '\n');
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

/** Prompt for a password with no echo. */
function promptPassword(prompt: string): Promise<string> {
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
        password = password.slice(0, -1);
      } else {
        password += c;
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
  .action(async (opts: { simple?: boolean; continue?: boolean; resume?: string; fork?: string; lfg?: boolean }) => {
    const config = loadConfig();

    // --lfg: full auto mode, skip all permission confirmations
    if (opts.lfg) {
      config.general.defaultPermissionMode = 'auto';
    }

    const db = getDb();
    const resolvedKeys = await resolveProviderKeys();
    const registry = await createProviderRegistry(config, resolvedKeys);
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    await connectMCPServers(tools, config);
    const sessionManager = new SessionManager(db);
    const projectPath = process.cwd();
    const { prompt: systemPrompt, frontmatter } = buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(config, registry, costTracker, frontmatter);

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

      console.log(`\n  brainstorm v0.1.0`);
      console.log(`  Strategy: ${config.general.defaultStrategy} | Models: ${localCount} local, ${cloudCount} cloud`);
      console.log(`  Type your message. /quit to exit.\n`);

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

        sessionManager.addUserMessage(input);
        let fullResponse = '';
        process.stdout.write('\nbrainstorm > ');
        simpleAbortController = new AbortController();

        for await (const event of runAgentLoop(sessionManager.getHistory(), {
          config, registry, router, costTracker, tools,
          sessionId: session.id, projectPath, systemPrompt,
          compaction: buildCompactionCallbacks(sessionManager),
          signal: simpleAbortController.signal,
        })) {
          if (event.type === 'routing') process.stderr.write(`[${event.decision.strategy} -> ${event.decision.model.name}] `);
          if (event.type === 'text-delta') { fullResponse += event.delta; process.stdout.write(event.delta); }
          if (event.type === 'gateway-feedback') { const gw = formatGatewayFeedback(event.feedback); if (gw) process.stderr.write(`\n  ${gw}`); }
          if (event.type === 'interrupted') process.stdout.write('\n  [interrupted]\n\n');
          if (event.type === 'done') process.stdout.write(`\n  [$${event.totalCost.toFixed(4)}]\n\n`);
          if (event.type === 'error') process.stdout.write(`\n  Error: ${event.error.message}\n\n`);
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
      }),
    );
  });

export function run() {
  program.parse();
}

run();
