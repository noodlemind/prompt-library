import fs from 'fs';
import path from 'path';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { readSession, writeSession } from './session.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { selectPlan } from './plan-parse.mjs';
import { loadPolicy } from './policy.mjs';
import { recordSkillUsage } from './telemetry.mjs';
import { scanSecrets } from './secret-scan.mjs';

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFC')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'insight'
  );
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Insight lane: evidence-free capture of investigation learnings. The quality
 * gate on the verified lane is untouched — insights are a separate episode
 * kind, ranked below verified fixes and barred from promotion.
 */
export function runInsightCompound({ workspace, copilotHome, flags, log = () => {} }) {
  const body = flags.body || (flags.bodyFile ? fs.readFileSync(path.resolve(flags.bodyFile), 'utf8') : '');
  if (!flags.title || !body.trim()) {
    return {
      pass: false,
      exitCode: 2,
      kind: 'insight',
      path: null,
      indexed: null,
      blockedReason: 'insight capture needs --title and --body (or --body-file)',
      nextTools: ['harness compound --insight --title "..." --body "..."'],
    };
  }
  const date = new Date().toISOString().slice(0, 10);
  // Category is one safe path segment — never a traversal vector.
  const category = slugify(flags.category || 'insights');
  const tags = flags.tags
    ? flags.tags
        .split(',')
        .map((t) => t.replace(/[^\w. -]/g, '').trim())
        .filter(Boolean)
        .join(',')
    : '';
  const fmLines = [`title: ${yamlQuote(flags.title)}`, 'kind: insight', `date: ${date}`];
  if (tags) fmLines.push(`tags: ${tags}`);
  if (flags.trigger) fmLines.push(`trigger: ${yamlQuote(flags.trigger)}`);
  if (flags.claim) fmLines.push(`claim: ${yamlQuote(flags.claim)}`);
  const doc = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}\n`;
  const secrets = scanSecrets(doc);
  if (secrets.length) {
    return {
      pass: false,
      exitCode: 1,
      kind: 'insight',
      path: null,
      indexed: null,
      blockedReason: `secret-shaped content blocked capture: ${secrets
        .map((s) => `${s.id}@${s.line}`)
        .join(', ')}`,
      nextTools: ['redact the credential and re-run'],
    };
  }
  // Never silently overwrite an earlier capture: same-day same-title collisions
  // get a deterministic numeric suffix.
  const base = `${date}-${slugify(flags.title)}`;
  const dirRel = path.join('docs', 'solutions', category);
  let rel = path.join(dirRel, `${base}.md`);
  let n = 2;
  while (fs.existsSync(path.join(workspace, rel))) {
    rel = path.join(dirRel, `${base}-${n}.md`);
    n += 1;
  }
  const full = path.join(workspace, rel);
  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, doc, 'utf8');
  }
  log(`wrote ${rel}`);
  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge')
    : null;
  const indexed = runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log });
  return {
    pass: true,
    exitCode: 0,
    kind: 'insight',
    path: rel.split(path.sep).join('/'),
    indexed,
    blockedReason: null,
    nextTools: ['harness consolidate --status'],
  };
}

export function runCompound({ workspace, copilotHome, flags, log = () => {} }) {
  if (flags.insight) return runInsightCompound({ workspace, copilotHome, flags, log });
  const session = readSession(workspace);
  const selected = selectPlan(workspace, { planPath: flags.plan, session, requireUnique: true });
  if (!selected.plan) {
    return {
      pass: false,
      exitCode: 2,
      plan: null,
      verificationEvidence: null,
      indexed: null,
      blockedReason: selected.error || 'No unambiguous plan; pass --plan explicitly',
      nextTools: ['harness verify --plan <path>', '/auto-compound'],
    };
  }

  const evidence = readEvidence(workspace, selected.plan.path);
  const freshness = validateEvidence({
    workspace,
    plan: selected.plan,
    evidence,
    maxAgeHours: loadPolicy(workspace, flags.enforcement).evidenceTtlHours,
  });
  if (!freshness.pass) {
    return {
      pass: false,
      exitCode: evidence?.outcome === 'failed' ? 1 : 2,
      plan: selected.plan.path,
      verificationEvidence: evidence,
      indexed: null,
      blockedReason: freshness.message,
      nextTools: [`harness verify --plan ${selected.plan.path}`, '/auto-compound'],
    };
  }

  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge')
    : null;

  const indexed = runIndexKnowledge({
    knowledgeRoot,
    workspace,
    copilotHome,
    flags,
    log,
  });

  const telemetry = recordSkillUsage({
    copilotHome,
    plan: selected.plan,
    evidence,
    dryRun: flags.dryRun,
  });

  const sessionState = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...sessionState,
      lastCompoundAt: new Date().toISOString(),
      lastIndexEntries: indexed.entries,
    },
    flags.dryRun
  );

  return {
    pass: true,
    exitCode: 0,
    plan: selected.plan.path,
    verificationEvidence: evidence,
    learning: selected.plan.fm.learning || null,
    telemetry,
    indexed,
    blockedReason: null,
    nextTools: ['/compound-learnings', '/auto-compound'],
  };
}
