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
  .option('--simple', 'Use simple readline interface instead of TUI')
  .action(async (opts: { simple?: boolean }) => {
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
