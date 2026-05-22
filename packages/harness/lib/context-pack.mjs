const MAX_BYTES = 2048;

export function buildContextPack({
  query,
  recall,
  plans,
  activePlan,
  gatePreview,
  nextTools,
}) {
  const lines = [
    '# Harness Context Pack',
    '',
    `> Generated for turn. Query: ${query || '(none)'}`,
    '',
    '## Recall (top matches)',
  ];

  if (!recall.length) {
    lines.push('- _(no manifest matches — run `harness index`)_');
  } else {
    for (const r of recall) {
      lines.push(`- **${r.title || r.id}** (\`${r.path}\`, score ${r.score.toFixed(2)})`);
      if (r.summary) lines.push(`  - ${r.summary.slice(0, 120)}`);
    }
  }

  lines.push('', '## Plans');
  if (!plans.length) {
    lines.push('- _(no title overlap)_');
  } else {
    for (const p of plans) {
      lines.push(
        `- \`${p.path}\` status=${p.status} lock=${p.plan_lock} score=${p.score?.toFixed?.(2) ?? p.score}`
      );
    }
  }

  if (activePlan) {
    lines.push('', '## Active plan', `- Path: \`${activePlan.path}\``);
    lines.push(`- status: ${activePlan.status} | plan_lock: ${activePlan.plan_lock} | phase: ${activePlan.phase}`);
    if (activePlan.memoryExcerpt) {
      lines.push('', '### Memory Cards (excerpt)', activePlan.memoryExcerpt);
    }
  }

  lines.push('', '## Gate (preview)');
  if (gatePreview) {
    lines.push(`- pass: ${gatePreview.pass}`);
    if (gatePreview.blockedReason) lines.push(`- blocked: ${gatePreview.blockedReason}`);
  }

  lines.push('', '## Next tools', ...(nextTools || []).map((t) => `- \`${t}\``));
  lines.push('', '---', '_Read this file only — do not paste full plans/solutions into chat._');

  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    body = body.slice(0, MAX_BYTES - 80) + '\n\n…(truncated to 2KB budget)\n';
  }
  return body;
}
