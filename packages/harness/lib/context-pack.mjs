import {
  CONTEXT_PACK_MAX_PLANS,
  excerptEditScope,
  excerptActivityTail,
} from './context-budget.mjs';

const MAX_BYTES = 2048;

export const CONTEXT_PACK_MAX_BYTES = MAX_BYTES;

/**
 * Build ≤2KB turn slice. Priority when truncating: active plan + gate > recall > plan titles.
 */
export function buildContextPack({
  query,
  recall,
  plans,
  activePlan,
  gatePreview,
  nextTools,
  codebaseMap,
  hostHints,
}) {
  const lines = [
    '# Harness Context Pack',
    '',
    `> Turn slice only. Query: ${query || '(none)'}`,
    '',
    '## Rules (frozen)',
    '- Read **this file only** — do not paste full plans, solutions, or CLI stdout into chat.',
    '- Code search: use host `#codebase` / semantic search when index is ready; else read `.harness/codebase-map.md`.',
    '- Solutions: `harness get --docid <id>` or read matched path (≤25 lines each).',
    '- Edits: `surgical-edit-policy.md`; run `harness gate` before `editFiles`.',
  ];

  if (hostHints?.length) {
    lines.push('', '## Host', ...hostHints.map((h) => `- ${h}`));
  }

  if (codebaseMap?.path) {
    lines.push(
      '',
      '## Codebase map',
      `- \`${codebaseMap.path}\` (${codebaseMap.ageDays}d old) — refresh: \`harness snapshot\``
    );
  }

  lines.push('', '## Gate (preview)');
  if (gatePreview) {
    lines.push(`- pass: ${gatePreview.pass}`);
    if (gatePreview.autonomy) lines.push(`- autonomy: ${gatePreview.autonomy}`);
    if (gatePreview.failedChecks?.length) {
      lines.push(`- failed: ${gatePreview.failedChecks.join(', ')}`);
    }
    if (gatePreview.blockedReason) {
      lines.push(`- blocked: ${gatePreview.blockedReason.slice(0, 200)}`);
    }
    if (!gatePreview.pass) {
      lines.push('- action: run skills listed under Next tools before implement');
    }
  }

  if (activePlan) {
    lines.push(
      '',
      '## Active plan',
      `- \`${activePlan.path}\` | status=${activePlan.status} | plan_lock=${activePlan.plan_lock} | phase=${activePlan.phase}`
    );
    if (activePlan.editStrategy) {
      lines.push(`- edit_strategy: ${activePlan.editStrategy}${activePlan.maxLines ? ` | max_lines: ${activePlan.maxLines}` : ''}`);
    }
    if (activePlan.impactedHint) {
      lines.push('', '### Impacted Files (hint)', activePlan.impactedHint.slice(0, 300));
    }
    if (activePlan.editScopeExcerpt) {
      lines.push('', '### Edit Scope', activePlan.editScopeExcerpt);
    }
    if (activePlan.memoryExcerpt) {
      lines.push('', '### Memory Cards', activePlan.memoryExcerpt);
    }
    if (activePlan.activityTail) {
      lines.push('', '### Activity (last entries)', activePlan.activityTail);
    }
  }

  lines.push('', '## Recall (top matches)');
  if (!recall.length) {
    lines.push('- _(none — run `harness index`)_');
  } else {
    for (const r of recall.slice(0, 3)) {
      const docid = r.docid || r.id;
      lines.push(`- **${r.title || docid}** \`${r.path}\` score=${r.score.toFixed(2)}`);
      const snip = (r.snippet || r.summary || '').slice(0, 80);
      if (snip) lines.push(`  - ${snip}`);
    }
  }

  const planSlice = plans.slice(0, CONTEXT_PACK_MAX_PLANS);
  if (planSlice.length) {
    lines.push('', '## Other plans (titles)');
    for (const p of planSlice) {
      lines.push(`- \`${p.path}\` status=${p.status} lock=${p.plan_lock}`);
    }
  }

  lines.push('', '## Next tools', ...(nextTools || []).map((t) => `- \`${t}\``));

  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    body = truncatePack(body, MAX_BYTES);
  }
  return body;
}

function truncatePack(body, maxBytes) {
  const marker = '\n## Recall';
  const idx = body.indexOf(marker);
  if (idx > 0 && Buffer.byteLength(body.slice(0, idx), 'utf8') < maxBytes - 120) {
    return body.slice(0, idx) + '\n\n…(recall/plans dropped to fit 2KB budget)\n';
  }
  return body.slice(0, maxBytes - 80) + '\n\n…(truncated to 2KB budget)\n';
}
