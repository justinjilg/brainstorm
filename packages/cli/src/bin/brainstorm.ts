import { Command } from 'commander';
import { loadConfig } from '@brainstorm/config';
import { getDb } from '@brainstorm/db';
import { createProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import { createDefaultToolRegistry } from '@brainstorm/tools';
import { runAgentLoop, buildSystemPrompt, SessionManager } from '@brainstorm/core';

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
          process.stdout.write(event.delta);
          break;
        case 'tool-call-start':
          process.stderr.write(`\n[tool: ${event.toolName}]\n`);
          break;
        case 'done':
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

program
  .command('chat', { isDefault: true })
  .description('Start an interactive chat session')
  .action(async () => {
    // For v0.1, use a simple readline loop
    // Ink TUI will be added as we iterate
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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

    const localCount = registry.models.filter((m) => m.isLocal).length;
    const cloudCount = registry.models.filter((m) => !m.isLocal).length;

    console.log(`\n🧠 Brainstorm v0.1.0`);
    console.log(`   Strategy: ${config.general.defaultStrategy} | Models: ${localCount} local, ${cloudCount} cloud`);
    console.log(`   Type your message. Press Ctrl+C to exit.\n`);

    while (true) {
      const input = await rl.question('you > ');
      if (!input.trim()) continue;
      if (input.trim() === '/quit' || input.trim() === '/exit') break;

      if (input.trim() === '/models') {
        for (const m of registry.models) {
          const tag = m.isLocal ? 'local' : 'cloud';
          console.log(`  ${m.status === 'available' ? '●' : '○'} ${m.id} [${tag}] quality:${m.capabilities.qualityTier}`);
        }
        continue;
      }

      if (input.trim() === '/cost') {
        const summary = costTracker.getSummary();
        console.log(`  Session: $${summary.session.toFixed(4)} | Today: $${summary.today.toFixed(4)}`);
        continue;
      }

      sessionManager.addUserMessage(input);

      let fullResponse = '';
      process.stdout.write('\nbrainstorm > ');

      for await (const event of runAgentLoop(sessionManager.getHistory(), {
        config, registry, router, costTracker, tools,
        sessionId: session.id, projectPath, systemPrompt,
      })) {
        switch (event.type) {
          case 'routing':
            process.stderr.write(`[${event.decision.strategy} → ${event.decision.model.name}] `);
            break;
          case 'text-delta':
            fullResponse += event.delta;
            process.stdout.write(event.delta);
            break;
          case 'tool-call-start':
            process.stdout.write(`\n  [tool: ${event.toolName}] `);
            break;
          case 'tool-call-result':
            process.stdout.write('done\n');
            break;
          case 'done':
            process.stdout.write(`\n  [$${event.totalCost.toFixed(4)}]\n\n`);
            break;
          case 'error':
            process.stdout.write(`\n  Error: ${event.error.message}\n\n`);
            break;
        }
      }

      if (fullResponse) {
        sessionManager.addAssistantMessage(fullResponse);
      }
    }

    rl.close();
    console.log('\nGoodbye!');
  });

export function run() {
  program.parse();
}

run();
