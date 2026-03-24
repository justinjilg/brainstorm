import type { Probe, CheckResult } from './types.js';

export interface ProbeOutput {
  output: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  steps: number;
  sandboxDir: string;
}

/**
 * Score a probe result against its verification criteria.
 * Returns individual check results — all must pass for the probe to pass.
 */
export function scoreProbe(probe: Probe, result: ProbeOutput): CheckResult[] {
  const checks: CheckResult[] = [];
  const v = probe.verify;

  // Tool call inclusion check
  if (v.tool_calls_include) {
    const toolNames = new Set(result.toolCalls.map((t) => t.name));
    for (const required of v.tool_calls_include) {
      checks.push({
        check: `tool_calls_include: ${required}`,
        passed: toolNames.has(required),
        detail: toolNames.has(required) ? undefined : `Tool '${required}' not called. Used: ${[...toolNames].join(', ')}`,
      });
    }
  }

  // Tool call exclusion check
  if (v.tool_calls_exclude) {
    const toolNames = new Set(result.toolCalls.map((t) => t.name));
    for (const forbidden of v.tool_calls_exclude) {
      checks.push({
        check: `tool_calls_exclude: ${forbidden}`,
        passed: !toolNames.has(forbidden),
        detail: toolNames.has(forbidden) ? `Tool '${forbidden}' was called but should not have been` : undefined,
      });
    }
  }

  // Answer content checks
  if (v.answer_contains) {
    const lower = result.output.toLowerCase();
    for (const expected of v.answer_contains) {
      const found = lower.includes(expected.toLowerCase());
      checks.push({
        check: `answer_contains: "${expected}"`,
        passed: found,
        detail: found ? undefined : `Output does not contain "${expected}"`,
      });
    }
  }

  // Answer exclusion checks
  if (v.answer_excludes) {
    const lower = result.output.toLowerCase();
    for (const forbidden of v.answer_excludes) {
      const found = lower.includes(forbidden.toLowerCase());
      checks.push({
        check: `answer_excludes: "${forbidden}"`,
        passed: !found,
        detail: found ? `Output contains forbidden text "${forbidden}"` : undefined,
      });
    }
  }

  // Step count checks
  if (v.min_steps !== undefined) {
    checks.push({
      check: `min_steps: ${v.min_steps}`,
      passed: result.steps >= v.min_steps,
      detail: result.steps < v.min_steps ? `Only ${result.steps} steps, need at least ${v.min_steps}` : undefined,
    });
  }

  if (v.max_steps !== undefined) {
    checks.push({
      check: `max_steps: ${v.max_steps}`,
      passed: result.steps <= v.max_steps,
      detail: result.steps > v.max_steps ? `Used ${result.steps} steps, max allowed is ${v.max_steps}` : undefined,
    });
  }

  // Code compilation check (deferred to PR #3 — needs TypeScript compiler integration)
  if (v.code_compiles) {
    checks.push({
      check: 'code_compiles',
      passed: true, // TODO: implement in PR #3
      detail: 'Compilation check not yet implemented',
    });
  }

  // File modification check (deferred — needs filesystem diff tracking)
  if (v.files_modified) {
    checks.push({
      check: `files_modified: ${v.files_modified.join(', ')}`,
      passed: true, // TODO: implement with sandbox file diff
      detail: 'File modification check not yet implemented',
    });
  }

  return checks;
}
