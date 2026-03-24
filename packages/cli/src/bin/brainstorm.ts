import { Command } from 'commander';
import { loadConfig } from '@brainstorm/config';
import { getDb } from '@brainstorm/db';
import { createProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt, SessionManager } from '@brainstorm/core';
import { AgentManager, parseAgentNL } from '@brainstorm/agents';
import { runWorkflow, getPresetWorkflow, autoSelectPreset, PRESET_WORKFLOWS } from '@brainstorm/workflow';
import { renderMarkdownToString } from '../components/MarkdownRenderer.js';

const program = new Command();

program
  .name('brainstorm')
  .description('AI coding assistant with intelligent model routing')
  .version('0.1.0');

program
  .command('models')
  .description('List available models and their status')
  .action(async () => {
    const config = loadConfig();
    const registry = await createProviderRegistry(config);

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
    const registry = await createProviderRegistry(config);
    const costTracker = new CostTracker(db, config.budget);
    const router = new BrainstormRouter(config, registry, costTracker);
    const agentManager = new AgentManager(db, config);
    const projectPath = process.cwd();

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
  .action(async (prompt: string) => {
    const config = loadConfig();
    const db = getDb();
    const registry = await createProviderRegistry(config);
    const costTracker = new CostTracker(db, config.budget);
    const router = new BrainstormRouter(config, registry, costTracker);
    const tools = createDefaultToolRegistry();
    const sessionManager = new SessionManager(db);
    const projectPath = process.cwd();
    const session = sessionManager.start(projectPath);
    const systemPrompt = buildSystemPrompt(projectPath);

    sessionManager.addUserMessage(prompt);

    let fullResponse = '';
    process.stdout.write('\n');

    for await (const event of runAgentLoop(sessionManager.getHistory(), {
      config, registry, router, costTracker, tools,
      sessionId: session.id, projectPath, systemPrompt,
      disableTools: true,
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
        case 'done':
          // Render full response with markdown formatting
          process.stdout.write(renderMarkdownToString(fullResponse));
          process.stdout.write(`\n\n[cost: $${event.totalCost.toFixed(4)}]\n`);
          break;
        case 'error':
          process.stderr.write(`\nError: ${event.error.message}\n`);
          break;
      }
    }

    if (fullResponse) {
      sessionManager.addAssistantMessage(fullResponse);
    }
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
  .action(async (opts: { simple?: boolean; continue?: boolean; resume?: string; fork?: string }) => {
    const config = loadConfig();
    const db = getDb();
    const registry = await createProviderRegistry(config);
    const costTracker = new CostTracker(db, config.budget);
    const router = new BrainstormRouter(config, registry, costTracker);
    const tools = createDefaultToolRegistry();
    const sessionManager = new SessionManager(db);
    const projectPath = process.cwd();

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

    const systemPrompt = buildSystemPrompt(projectPath);

    const localCount = registry.models.filter((m) => m.isLocal).length;
    const cloudCount = registry.models.filter((m) => !m.isLocal).length;

    if (opts.simple) {
      // Simple readline fallback
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      console.log(`\n  brainstorm v0.1.0`);
      console.log(`  Strategy: ${config.general.defaultStrategy} | Models: ${localCount} local, ${cloudCount} cloud`);
      console.log(`  Type your message. /quit to exit.\n`);

      while (true) {
        const input = await rl.question('you > ');
        if (!input.trim()) continue;
        if (input.trim() === '/quit' || input.trim() === '/exit') break;

        sessionManager.addUserMessage(input);
        let fullResponse = '';
        process.stdout.write('\nbrainstorm > ');

        for await (const event of runAgentLoop(sessionManager.getHistory(), {
          config, registry, router, costTracker, tools,
          sessionId: session.id, projectPath, systemPrompt,
        })) {
          if (event.type === 'routing') process.stderr.write(`[${event.decision.strategy} -> ${event.decision.model.name}] `);
          if (event.type === 'text-delta') { fullResponse += event.delta; process.stdout.write(event.delta); }
          if (event.type === 'done') process.stdout.write(`\n  [$${event.totalCost.toFixed(4)}]\n\n`);
          if (event.type === 'error') process.stdout.write(`\n  Error: ${event.error.message}\n\n`);
        }
        if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
      }
      rl.close();
      return;
    }

    // Ink TUI
    const { render } = await import('ink');
    const React = await import('react');
    const { ChatApp } = await import('../components/ChatApp.js');

    function handleSendMessage(text: string) {
      sessionManager.addUserMessage(text);
      const gen = runAgentLoop(sessionManager.getHistory(), {
        config, registry, router, costTracker, tools,
        sessionId: session.id, projectPath, systemPrompt,
      });
      // Wrap to capture assistant message after completion
      return (async function* () {
        let fullResponse = '';
        for await (const event of gen) {
          if (event.type === 'text-delta') fullResponse += event.delta;
          yield event;
        }
        if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
      })();
    }

    render(
      React.createElement(ChatApp, {
        strategy: config.general.defaultStrategy,
        modelCount: { local: localCount, cloud: cloudCount },
        onSendMessage: handleSendMessage,
      }),
    );
  });

export function run() {
  program.parse();
}

run();
