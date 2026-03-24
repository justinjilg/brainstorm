import type { CapabilityScorecard, CapabilityDimension } from './types.js';

const DIMENSION_LABELS: Record<CapabilityDimension, string> = {
  'tool-selection': 'Tool Selection',
  'tool-sequencing': 'Tool Sequencing',
  'code-correctness': 'Code Correctness',
  'multi-step': 'Multi-Step',
  'instruction-adherence': 'Instruction Adherence',
  'context-utilization': 'Context Utilization',
  'self-correction': 'Self-Correction',
};

/**
 * Format a capability scorecard for terminal display.
 */
export function formatScorecard(scorecard: CapabilityScorecard): string {
  const lines: string[] = [];
  const modelName = scorecard.modelId;

  lines.push('');
  lines.push(`  Capability Scorecard: ${modelName}`);
  lines.push('  ' + '─'.repeat(45));

  const dimensions: CapabilityDimension[] = [
    'tool-selection', 'tool-sequencing', 'code-correctness',
    'multi-step', 'instruction-adherence', 'context-utilization', 'self-correction',
  ];

  for (const dim of dimensions) {
    const data = scorecard.dimensions[dim];
    if (!data || data.total === 0) continue;

    const label = DIMENSION_LABELS[dim].padEnd(24);
    const pct = Math.round(data.score * 100);
    const bar = renderBar(data.score);
    lines.push(`  ${label} ${data.passed}/${data.total} (${pct}%) ${bar}`);
  }

  lines.push('  ' + '─'.repeat(45));

  const { overall } = scorecard;
  const overallPct = Math.round(overall.score * 100);
  lines.push(`  ${'Overall'.padEnd(24)} ${overall.passed}/${overall.total} (${overallPct}%)`);
  lines.push(`  ${'Cost'.padEnd(24)} $${overall.cost.toFixed(4)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a comparison table of multiple scorecards.
 */
export function formatComparison(scorecards: CapabilityScorecard[]): string {
  if (scorecards.length === 0) return '  No eval results found.\n';

  const lines: string[] = [];
  const dimensions: CapabilityDimension[] = [
    'tool-selection', 'tool-sequencing', 'code-correctness',
    'multi-step', 'instruction-adherence', 'context-utilization', 'self-correction',
  ];

  // Header
  const modelNames = scorecards.map((s) => s.modelId.split('/').pop() ?? s.modelId);
  const colWidth = Math.max(12, ...modelNames.map((n) => n.length + 2));

  lines.push('');
  lines.push('  ' + ''.padEnd(24) + modelNames.map((n) => n.padStart(colWidth)).join(''));
  lines.push('  ' + '─'.repeat(24 + colWidth * scorecards.length));

  for (const dim of dimensions) {
    const label = DIMENSION_LABELS[dim].padEnd(24);
    const values = scorecards.map((sc) => {
      const d = sc.dimensions[dim];
      if (!d || d.total === 0) return '—'.padStart(colWidth);
      return `${Math.round(d.score * 100)}%`.padStart(colWidth);
    });
    lines.push(`  ${label}${values.join('')}`);
  }

  lines.push('  ' + '─'.repeat(24 + colWidth * scorecards.length));

  const overalls = scorecards.map((sc) => `${Math.round(sc.overall.score * 100)}%`.padStart(colWidth));
  lines.push(`  ${'Overall'.padEnd(24)}${overalls.join('')}`);

  const costs = scorecards.map((sc) => `$${sc.overall.cost.toFixed(3)}`.padStart(colWidth));
  lines.push(`  ${'Cost'.padEnd(24)}${costs.join('')}`);
  lines.push('');

  return lines.join('\n');
}

function renderBar(score: number): string {
  const filled = Math.round(score * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
