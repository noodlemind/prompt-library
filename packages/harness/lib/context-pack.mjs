const MAX_BYTES = 2048;

export const CONTEXT_PACK_MAX_BYTES = MAX_BYTES;

export function buildContextPack({
  query,
  recall,
  learnings,
  plans,
  activePlan,
  planGoal,
  planView,
  repoMapRef,
  gatePreview,
  nextTools,
}) {
  // Order by priority so the 2 KB cap truncates the least-important content
  // last: high-value fixed sections (active plan, plan view, goal, gate, next
  // tools) first; variable, query-dependent retrieval (recall, plans) and the
  // volatile query footer at the end, which also keeps the prefix cache-stable.
  const lines = [
    '# Harness Context Pack',
    '',
    '> Read this file only — do not re-read full plans/solutions into chat.',
    '> Excludes plan ## Activity and ## Verification Evidence by design.',
  ];

  if (activePlan) {
    lines.push('', '## Active plan', `- Path: \`${activePlan.path}\``);
    lines.push(`- status: ${activePlan.status} | plan_lock: ${activePlan.plan_lock} | phase: ${activePlan.phase}`);
    if (activePlan.memoryExcerpt) {
      lines.push('', '### Memory Cards (excerpt)', activePlan.memoryExcerpt);
    }
  }

  if (planView) {
    lines.push('', '## Plan view (current phase)', planView.body);
  }

  if (planGoal) {
    lines.push('', '## Goal (Intent Contract)', `- Plan: \`${planGoal.planPath}\``);
    if (planGoal.intent) lines.push(`- intent: ${planGoal.intent}`);
    if (planGoal.success_criteria?.length) {
      lines.push('- success_criteria: ' + planGoal.success_criteria.slice(0, 3).join('; '));
    }
    if (planGoal.expected_outputs?.length) {
      lines.push('- expected_outputs: ' + planGoal.expected_outputs.slice(0, 3).join('; '));
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

  if (repoMapRef) {
    lines.push(
      '',
      '## Repo map (code orientation)',
      `- Read \`${repoMapRef.path}\` — ${repoMapRef.files} of ${repoMapRef.totalFiles} source files, ranked for this query. Start there instead of searching the tree.`
    );
  }

  // Semantic memory: attributed by id so behavior driven by a learning is
  // always traceable; insight-derived claims carry the advisory fence.
  if (learnings?.length) {
    lines.push('', '## Learnings (memory)');
    lines.push(`Applied learnings: ${learnings.map((l) => l.id).join(', ')}`);
    for (const l of learnings) {
      const fence = l.advisory ? ' [unverified memory — advisory]' : '';
      lines.push(`- [${l.id}]${fence} ${l.trigger} → ${l.claimLine}`);
    }
  }

  lines.push('', '## Next tools', ...(nextTools || []).map((t) => `- \`${t}\``));

  lines.push('', '## Recall (top matches)');
  if (!recall.length) {
    lines.push('- _(no manifest matches — run `harness index`)_');
  } else {
    for (const r of recall) {
      const docid = r.docid || r.id;
      const label = r.kind === 'insight' ? ' [insight]' : '';
      lines.push(`- **${r.title || docid}**${label} (\`${r.path}\`, docid \`${docid}\`, score ${r.score.toFixed(2)})`);
      if (r.snippet) lines.push(`  - ${r.snippet.slice(0, 120)}`);
      else if (r.summary) lines.push(`  - ${r.summary.slice(0, 120)}`);
    }
  }

  lines.push('', '## Plans');
  if (!plans.length) {
    lines.push('- _(no title overlap)_');
  } else {
    for (const p of plans) {
      lines.push(`- \`${p.path}\` status=${p.status} lock=${p.plan_lock} score=${p.score?.toFixed?.(2) ?? p.score}`);
    }
  }

  // Volatile field last, so the stable prefix above stays cache-friendly.
  lines.push('', '---', `_Turn context — query: ${query || '(none)'}._`);

  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    body = body.slice(0, MAX_BYTES - 80) + '\n\n…(truncated to 2KB budget)\n';
  }
  return body;
}
