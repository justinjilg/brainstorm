/**
 * God Mode HTML Evidence Reports — self-contained, static HTML rendering of
 * ChangeSet audit entries for compliance and governance review.
 *
 * The output is a single, fully self-contained HTML document: inline CSS only,
 * no external resources, no client JS required. Every dynamic value is
 * HTML-escaped, so hostile strings in any AuditEntry field render as inert
 * text rather than executable markup.
 *
 * Pair with evidence-bundle.ts to produce an HMAC-signed, tamper-evident
 * bundle over the exact HTML string this module generates.
 */

import type { AuditEntry } from "../audit.js";

export interface RenderReportOptions {
  /** Report heading. Defaults to "God Mode ChangeSet Evidence Report". */
  title?: string;
  /** Generation timestamp (epoch ms). Defaults to Date.now() at call time. */
  generatedAt?: number;
}

/**
 * Escape a string for safe interpolation into HTML text or attribute context.
 * Handles all five significant characters so `<script>`, `onerror=`, and
 * quote-breakouts render inert.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Risk severity bucket for CSS class + label. */
function riskSeverity(riskScore: number): "low" | "medium" | "high" {
  if (riskScore >= 70) return "high";
  if (riskScore >= 30) return "medium";
  return "low";
}

/** ISO-8601 string for an epoch-ms timestamp, or an em-dash when null. */
function formatTimestamp(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString();
}

/**
 * Pretty-print a JSON string by parse-and-reindent. If parsing fails, the raw
 * string is returned untouched (the caller escapes it). Returns escaped HTML.
 */
function renderJsonBlock(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") {
    return `<pre class="json empty">—</pre>`;
  }
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Malformed JSON: show the raw string, escaped.
    return `<pre class="json malformed">${escapeHtml(raw)}</pre>`;
  }
  return `<pre class="json">${escapeHtml(pretty)}</pre>`;
}

function renderCard(entry: AuditEntry): string {
  const severity = riskSeverity(entry.riskScore);
  return `      <article class="card">
        <header class="card-head">
          <h2 class="cs-id">${escapeHtml(entry.changesetId)}</h2>
          <span class="risk risk-${severity}" title="Risk score ${escapeHtml(
            entry.riskScore,
          )}">${severity.toUpperCase()} · ${escapeHtml(entry.riskScore)}</span>
        </header>
        <dl class="meta">
          <div><dt>Connector</dt><dd>${escapeHtml(entry.connector)}</dd></div>
          <div><dt>Action</dt><dd>${escapeHtml(entry.action)}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(entry.status)}</dd></div>
          <div><dt>Created</dt><dd>${escapeHtml(
            formatTimestamp(entry.createdAt),
          )}</dd></div>
          <div><dt>Executed</dt><dd>${escapeHtml(
            formatTimestamp(entry.executedAt),
          )}</dd></div>
        </dl>
        <p class="desc">${escapeHtml(entry.description)}</p>
        <details open>
          <summary>Changes</summary>
          ${renderJsonBlock(entry.changesJson)}
        </details>
        <details>
          <summary>Simulation</summary>
          ${renderJsonBlock(entry.simulationJson)}
        </details>
        <details>
          <summary>Rollback</summary>
          ${renderJsonBlock(entry.rollbackJson)}
        </details>
      </article>`;
}

const STYLE = `
    :root {
      --bg: #f6f7f9;
      --fg: #1a1d21;
      --muted: #5c6570;
      --card-bg: #ffffff;
      --border: #d9dde2;
      --pre-bg: #f0f2f4;
      --accent: #2d6cdf;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14171a;
        --fg: #e6e9ec;
        --muted: #9aa4af;
        --card-bg: #1d2226;
        --border: #2e353b;
        --pre-bg: #0f1215;
        --accent: #5a92ff;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem 4rem;
      background: var(--bg);
      color: var(--fg);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .wrap { max-width: 960px; margin: 0 auto; }
    header.report-head { border-bottom: 2px solid var(--border); padding-bottom: 1rem; margin-bottom: 1.5rem; }
    header.report-head h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
    .report-meta { color: var(--muted); font-size: .85rem; display: flex; gap: 1.25rem; flex-wrap: wrap; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.1rem 1.25rem;
      margin-bottom: 1.25rem;
    }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .cs-id { margin: 0; font-size: 1.05rem; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all; }
    .risk { flex: 0 0 auto; font-size: .72rem; font-weight: 700; letter-spacing: .04em; padding: .25rem .55rem; border-radius: 999px; white-space: nowrap; }
    .risk-low { background: #1f8a4c22; color: #1f8a4c; }
    .risk-medium { background: #c9820022; color: #c98200; }
    .risk-high { background: #d13a3a22; color: #d13a3a; }
    @media (prefers-color-scheme: dark) {
      .risk-low { color: #4cd07d; }
      .risk-medium { color: #f0b64b; }
      .risk-high { color: #ff6f6f; }
    }
    dl.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .5rem 1rem; margin: .9rem 0; }
    dl.meta div { min-width: 0; }
    dl.meta dt { color: var(--muted); font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; }
    dl.meta dd { margin: .1rem 0 0; word-break: break-word; }
    .desc { margin: .5rem 0 1rem; }
    details { margin: .4rem 0; }
    summary { cursor: pointer; font-weight: 600; color: var(--accent); font-size: .85rem; }
    pre.json {
      background: var(--pre-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: .75rem;
      overflow-x: auto;
      font: 12.5px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      white-space: pre;
      margin: .4rem 0 0;
    }
    pre.json.malformed { border-color: #d13a3a; }
    pre.json.empty { color: var(--muted); }
    .empty-state { text-align: center; color: var(--muted); padding: 3rem 0; }
`;

/**
 * Render a self-contained HTML evidence report for a set of ChangeSet audit
 * entries. Output is deterministic given identical inputs (the same entries
 * and the same `generatedAt`), which lets evidence-bundle.ts hash and sign it.
 */
export function renderChangeSetReport(
  entries: AuditEntry[],
  opts: RenderReportOptions = {},
): string {
  const title = opts.title ?? "God Mode ChangeSet Evidence Report";
  const generatedAt = opts.generatedAt ?? Date.now();
  const generatedIso = formatTimestamp(generatedAt);

  const body =
    entries.length === 0
      ? `      <p class="empty-state">No ChangeSet audit entries to report.</p>`
      : entries.map(renderCard).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header class="report-head">
      <h1>${escapeHtml(title)}</h1>
      <div class="report-meta">
        <span>Generated: ${escapeHtml(generatedIso)}</span>
        <span>Entries: ${escapeHtml(entries.length)}</span>
      </div>
    </header>
    <main>
${body}
    </main>
  </div>
</body>
</html>`;
}
