import fs from 'node:fs';
import path from 'node:path';
import { eventPath } from './events.mjs';
import { summarizeUsage } from './token-meter.mjs';

// A report reads more history than the bounded `events` view, but is still
// capped so a runaway log cannot blow up memory or output.
const REPORT_EVENT_CAP = 2000;

// Static budget caps (mirrors the enforced values in prompt-library-contracts).
export const BUDGETS = { agentTokens: 900, skillLines: 300, packBytes: 2048 };
const RECOVERY_LOOP_MIN_BLOCKS = 2;
const RECOVERY_LOOP_FLAT_COST = 2500; // baseline tokens per block→recover→retry cycle
const TREND_DRIFT_RATIO = 1.2;

function estimateTokensLite(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** Read events for a report from an explicit list or a workspace log, capped. */
export function loadReportEvents({ workspace, events }) {
  if (Array.isArray(events)) return events.slice(-REPORT_EVENT_CAP);
  const file = eventPath(workspace);
  if (!fs.existsSync(file)) return [];
  const parsed = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return parsed.slice(-REPORT_EVENT_CAP);
}

function rankSinks(events) {
  const byType = new Map();
  for (const event of events) {
    const total = event.usage?.['gen_ai.usage.total_tokens'] || 0;
    if (!total) continue;
    const bucket = byType.get(event.type) || { type: event.type, tokens: 0, count: 0, source: 'est' };
    bucket.tokens += total;
    bucket.count += 1;
    if (event.source === 'host') bucket.source = 'host';
    byType.set(event.type, bucket);
  }
  return [...byType.values()]
    .map((b) => ({ ...b, avg: Math.round(b.tokens / b.count) }))
    .sort((a, b) => b.tokens - a.tokens);
}

function topSessions(events, limit = 3) {
  const bySession = new Map();
  for (const event of events) {
    const total = event.usage?.['gen_ai.usage.total_tokens'] || 0;
    const key = event.session || '(no session)';
    const bucket = bySession.get(key) || { session: key, tokens: 0, count: 0 };
    bucket.tokens += total;
    bucket.count += 1;
    bySession.set(key, bucket);
  }
  return [...bySession.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

/** Budget breaches over the authoritative prompt-library artifacts.
 * Scans the FIRST root that actually has artifacts (workspace `.github` when
 * present, else the hydrated `~/.copilot`) — never both, so a clean workspace
 * is not judged against a stale global install. */
export function budgetBreaches({ workspace, copilotHome }) {
  const roots = [
    { agents: path.join(workspace, '.github', 'agents'), skills: path.join(workspace, '.github', 'skills') },
    copilotHome ? { agents: path.join(copilotHome, 'agents'), skills: path.join(copilotHome, 'skills') } : null,
  ].filter(Boolean);
  const root = roots.find(
    (r) => fs.existsSync(path.join(r.agents, 'engineer.agent.md')) || fs.existsSync(r.skills)
  );
  if (!root) return [];

  const breaches = [];
  const agentFile = path.join(root.agents, 'engineer.agent.md');
  if (fs.existsSync(agentFile)) {
    const tokens = Math.ceil(fs.statSync(agentFile).size / 4);
    if (tokens > BUDGETS.agentTokens) {
      breaches.push({ kind: 'agent', target: 'engineer.agent.md', value: tokens, cap: BUDGETS.agentTokens });
    }
  }
  if (fs.existsSync(root.skills)) {
    for (const entry of fs.readdirSync(root.skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.skills, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const lines = fs.readFileSync(skillFile, 'utf8').split('\n').length;
      if (lines > BUDGETS.skillLines) {
        breaches.push({ kind: 'skill', target: `${entry.name}/SKILL.md`, value: lines, cap: BUDGETS.skillLines });
      }
    }
  }
  return breaches;
}

/** Sessions where enforcement blocked repeatedly, with an estimated token cost. */
export function recoveryLoops(events) {
  const bySession = new Map();
  for (const event of events) {
    const key = event.session || '(no session)';
    const blocked = event.decision === 'block' || event.result === 'fail';
    const bucket = bySession.get(key) || { session: key, blocks: 0, burned: 0 };
    if (blocked) {
      bucket.blocks += 1;
      bucket.burned += event.usage?.['gen_ai.usage.total_tokens'] || RECOVERY_LOOP_FLAT_COST;
    }
    bySession.set(key, bucket);
  }
  return [...bySession.values()]
    .filter((s) => s.blocks >= RECOVERY_LOOP_MIN_BLOCKS)
    .sort((a, b) => b.burned - a.burned);
}

/** Tokens-per-session trend: recent half vs earlier half. Null under 2 sessions. */
export function trendRegression(events) {
  const bySession = new Map();
  for (const event of events) {
    const key = event.session || null;
    if (!key) continue;
    const total = event.usage?.['gen_ai.usage.total_tokens'] || 0;
    const bucket = bySession.get(key) || { session: key, tokens: 0, firstTs: event.ts };
    bucket.tokens += total;
    if (event.ts && event.ts < bucket.firstTs) bucket.firstTs = event.ts;
    bySession.set(key, bucket);
  }
  const sessions = [...bySession.values()].sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
  if (sessions.length < 2) return null;
  const mid = Math.floor(sessions.length / 2);
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.tokens, 0) / arr.length : 0);
  const earlier = mean(sessions.slice(0, mid));
  const recent = mean(sessions.slice(mid));
  const ratio = earlier ? recent / earlier : 1;
  return {
    earlier: Math.round(earlier),
    recent: Math.round(recent),
    ratio: Number(ratio.toFixed(2)),
    regressed: ratio >= TREND_DRIFT_RATIO,
    sessions: sessions.length,
  };
}

// How many per-session performance rows the report shows (highest-token first).
const SESSION_PERF_CAP = 10;

/** Tokens for an event, matching summarizeUsage: explicit total, else input +
 * output, else 0 — so session rankings track the report roll-ups. */
function eventTokens(event) {
  const usage = event.usage;
  if (!usage) return 0;
  const recorded = usage['gen_ai.usage.total_tokens'];
  if (Number.isFinite(recorded)) return recorded;
  return (usage['gen_ai.usage.input_tokens'] || 0) + (usage['gen_ai.usage.output_tokens'] || 0);
}

/** Per-session performance rows and roll-up, from host events carrying metrics. */
export function sessionPerformance(events) {
  const rows = events
    .filter((e) => e.metrics)
    .map((e) => ({
      session: e.session || '(no session)',
      ts: e.ts || null,
      tokens: eventTokens(e),
      ...e.metrics,
    }));
  rows.sort((a, b) => b.tokens - a.tokens);
  const totals = rows.reduce(
    (acc, r) => {
      acc.sessions += 1;
      acc.tokens += r.tokens || 0;
      acc.premiumRequests += r.premiumRequests || 0;
      acc.apiRequests += r.apiRequests || 0;
      acc.apiDurationMs += r.apiDurationMs || 0;
      acc.turns += r.turns || 0;
      acc.toolCalls += r.toolCalls || 0;
      acc.toolFailures += r.toolFailures || 0;
      acc.linesAdded += r.linesAdded || 0;
      acc.linesRemoved += r.linesRemoved || 0;
      return acc;
    },
    { sessions: 0, tokens: 0, premiumRequests: 0, apiRequests: 0, apiDurationMs: 0, turns: 0, toolCalls: 0, toolFailures: 0, linesAdded: 0, linesRemoved: 0 }
  );
  return { rows: rows.slice(0, SESSION_PERF_CAP), totals };
}

export function buildReport({ workspace, copilotHome, events }) {
  const all = loadReportEvents({ workspace, events });
  const usage = summarizeUsage(all);
  const withUsage = all.filter((e) => e.usage);
  const span = {
    from: all.length ? all[0].ts : null,
    to: all.length ? all[all.length - 1].ts : null,
    sessions: new Set(all.map((e) => e.session).filter(Boolean)).size,
  };
  const hostBacked = all.some((e) => e.source === 'host');
  const performance = sessionPerformance(all);
  return {
    totals: { tokens: usage.totalTokens, input: usage.inputTokens, output: usage.outputTokens, events: all.length, measured: withUsage.length },
    span,
    hostBacked,
    sinks: rankSinks(all),
    topSessions: topSessions(all),
    sessions: performance.rows,
    sessionTotals: performance.totals,
    flags: {
      budgetBreaches: budgetBreaches({ workspace, copilotHome }),
      recoveryLoops: recoveryLoops(all),
      trend: trendRegression(all),
    },
  };
}

function bar(value, max, width = 24) {
  if (!max) return '';
  const full = Math.round((value / max) * width);
  return '█'.repeat(full) + '·'.repeat(Math.max(0, width - full));
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtPct(r) {
  return r == null ? '-' : `${Math.round(r * 100)}%`;
}

function fmtTokens(n) {
  if (n == null) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Compact per-session performance table (local session metrics). */
function renderSessionPerformance(report) {
  const rows = report.sessions || [];
  if (!rows.length) return [];
  const tt = report.sessionTotals || {};
  const out = [
    '',
    `Local session performance — ${tt.sessions} session(s), ${tt.premiumRequests} premium req, ` +
      `${fmtDuration(tt.apiDurationMs)} API, ${tt.turns} turns, ${tt.toolCalls} tools (${tt.toolFailures} failed), ` +
      `+${tt.linesAdded}/-${tt.linesRemoved} lines:`,
  ];
  const header = ['session', 'model', 'tokens', 'prem', 'turns', 'tools(f)', 'skills', 'API', 'cache', 'ctx', 'lines'];
  const table = rows.map((r) => [
    String(r.session).slice(0, 8),
    r.model || '-',
    fmtTokens(r.tokens),
    String(r.premiumRequests ?? '-'),
    String(r.turns ?? '-'),
    `${r.toolCalls ?? 0}(${r.toolFailures ?? 0})`,
    String(r.skills ?? 0),
    fmtDuration(r.apiDurationMs),
    fmtPct(r.cacheReadRatio),
    fmtTokens(r.contextTokens),
    `+${r.linesAdded ?? 0}/-${r.linesRemoved ?? 0}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const fmtRow = (row) => '  ' + row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  out.push(fmtRow(header));
  for (const row of table) out.push(fmtRow(row));
  return out;
}

export function renderReport(report) {
  const lines = [];
  const t = report.totals;
  const src = report.hostBacked ? 'host-backed + estimated' : 'estimated (chars/4)';
  lines.push(
    `harness report: ~${t.tokens} tokens across ${t.events} events, ${report.span.sessions} session(s) — ${src}`
  );
  if (report.span.from) lines.push(`  span: ${report.span.from} → ${report.span.to}`);

  lines.push('', 'Top token sinks (by event type):');
  if (!report.sinks.length) {
    lines.push('  (no token usage recorded yet — run some harness commands, then report)');
  } else {
    const max = report.sinks[0].tokens;
    const pad = Math.max(...report.sinks.map((s) => s.type.length));
    for (const s of report.sinks) {
      lines.push(`  ${s.type.padEnd(pad)}  ${String(s.tokens).padStart(7)}  ${bar(s.tokens, max)}  n=${s.count} avg=${s.avg}`);
    }
  }

  lines.push(...renderSessionPerformance(report));

  const f = report.flags;
  const flagLines = [];
  for (const b of f.budgetBreaches) {
    flagLines.push(`  [budget] ${b.kind} ${b.target} = ${b.value} > cap ${b.cap}`);
  }
  for (const loop of f.recoveryLoops) {
    flagLines.push(`  [recovery-loop] session ${loop.session}: ${loop.blocks} blocks, ~${loop.burned} tokens burned`);
  }
  if (f.trend?.regressed) {
    flagLines.push(`  [trend] tokens/session rising: ${f.trend.earlier} → ${f.trend.recent} (${f.trend.ratio}×, ${f.trend.sessions} sessions)`);
  }
  lines.push('', flagLines.length ? 'Improvement flags:' : 'Improvement flags: none');
  lines.push(...flagLines);
  return lines.join('\n');
}

/** True when any budget cap is breached (for `--check` / CI use). */
export function hasBudgetBreach(report) {
  return report.flags.budgetBreaches.length > 0;
}
