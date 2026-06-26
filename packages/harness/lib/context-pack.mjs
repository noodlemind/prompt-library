const MAX_BYTES = 2048;

export const CONTEXT_PACK_MAX_BYTES = MAX_BYTES;

export function buildContextPack({
  query,
  recall,
  plans,
  activePlan,
  planGoal,
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
      const docid = r.docid || r.id;
      lines.push(
        `- **${r.title || docid}** (\`${r.path}\`, docid \`${docid}\`, score ${r.score.toFixed(2)})`
      );
      if (r.snippet) lines.push(`  - ${r.snippet.slice(0, 120)}`);
      else if (r.summary) lines.push(`  - ${r.summary.slice(0, 120)}`);
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

  if (planGoal) {
    lines.push('', '## Goal (Intent Contract)', `- Plan: \`${planGoal.planPath}\``);
    if (planGoal.intent) lines.push(`- intent: ${planGoal.intent}`);
    if (planGoal.success_criteria?.length) {
      lines.push(
        '- success_criteria: ' + planGoal.success_criteria.slice(0, 3).join('; ')
      );
    }
    if (planGoal.expected_outputs?.length) {
      lines.push(
        '- expected_outputs: ' + planGoal.expected_outputs.slice(0, 3).join('; ')
      );
    }
    if (planGoal.intentContractExcerpt) {
      lines.push('', '### Intent Contract (excerpt)', planGoal.intentContractExcerpt);
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
