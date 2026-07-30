import fs from 'fs';
import path from 'path';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { readSession, writeSession } from './session.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { selectPlan } from './plan-parse.mjs';
import { loadPolicy } from './policy.mjs';
import { recordSkillUsage } from './telemetry.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { assertNoSymlinkAncestors, writeFileContained } from './fs-safe.mjs';

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
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Insight lane: evidence-free capture of investigation learnings. The quality
 * gate on the verified lane is untouched — insights are a separate episode
 * kind, ranked below verified fixes and barred from promotion.
 */
export function runInsightCompound({ workspace, copilotHome, flags, log = () => {}, kind = 'insight', home }) {
  // Kill switch: only the fully-off mode blocks insight capture — freeze and
  // capture-only both keep this lane open (the mode matrix, Task 4).
  const { mode } = readStoreConfig(workspace, { home });
  if (mode === 'off') {
    return {
      pass: false,
      exitCode: 2,
      kind,
      path: null,
      indexed: null,
      blockedReason: `knowledge mode is ${mode} — run: harness knowledge on`,
      nextTools: ['harness knowledge on'],
    };
  }
  const body = flags.body || (flags.bodyFile ? fs.readFileSync(path.resolve(flags.bodyFile), 'utf8') : '');
  if (!flags.title || !body.trim()) {
    return {
      pass: false,
      exitCode: 2,
      kind,
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
  const fmLines = [`title: ${yamlQuote(flags.title)}`, `kind: ${kind}`, `date: ${date}`];
  if (tags) fmLines.push(`tags: ${tags}`);
  if (flags.trigger) fmLines.push(`trigger: ${yamlQuote(flags.trigger)}`);
  if (flags.claim) fmLines.push(`claim: ${yamlQuote(flags.claim)}`);
  const doc = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}\n`;
  const secrets = scanSecrets(doc);
  if (secrets.length) {
    return {
      pass: false,
      exitCode: 1,
      kind,
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
  // Physical containment (sweep-completeness finding, probe C): this is the
  // PRIMARY episode write path for both `harness compound --insight` and
  // `harness remember` (remember.mjs calls this with kind: 'human-teaching')
  // — a symlinked docs/solutions (or category) directory must never let it
  // land outside the workspace. Checked BEFORE the collision-avoidance loop
  // below even probes existence through it, and fails loudly (a blocked
  // result, not a silent no-op) rather than writing outside — unlike
  // admin.mjs's absorb-snapshot writer (a best-effort side channel that can
  // afford to skip), this IS the write the caller asked for.
  if (!assertNoSymlinkAncestors(workspace, dirRel)) {
    return {
      pass: false,
      exitCode: 1,
      kind,
      path: null,
      indexed: null,
      blockedReason: 'episode path escapes the workspace (symlinked docs/solutions?)',
      nextTools: ['remove or replace the symlinked docs/solutions directory and re-run'],
    };
  }
  let rel = path.join(dirRel, `${base}.md`);
  let n = 2;
  while (fs.existsSync(path.join(workspace, rel))) {
    rel = path.join(dirRel, `${base}-${n}.md`);
    n += 1;
  }
  if (!flags.dryRun) {
    // writeFileContained re-validates containment (TOCTOU-safe) and writes
    // atomically (tmp + rename) — the SAME helper admin.mjs's mirror/absorb
    // writers and repo-map's writeCodebaseMap already use.
    const written = writeFileContained(workspace, rel, doc);
    if (!written) {
      return {
        pass: false,
        exitCode: 1,
        kind,
        path: null,
        indexed: null,
        blockedReason: 'episode path escapes the workspace (symlinked docs/solutions?)',
        nextTools: ['remove or replace the symlinked docs/solutions directory and re-run'],
      };
    }
  }
  // Under dryRun nothing was actually written (the write above is skipped), so
  // the log line must not claim otherwise.
  log(`${flags.dryRun ? 'would write' : 'wrote'} ${rel}`);
  const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
    ? path.join(copilotHome, 'knowledge')
    : null;
  // runIndexKnowledge can throw (a duplicate manifest id, an fs error). An
  // unhandled throw here would leave the episode we JUST wrote orphaned on disk
  // and, for the `remember` caller, skip its rollback path entirely (the throw
  // never reaches `if (!episode.pass)`). Snapshot the manifest, and on any
  // index failure: delete the just-written episode and restore the prior
  // manifest so retrieval state is exactly pre-write, then return a clean,
  // recoverable failure the caller's normal not-pass path handles.
  const manifestPath = path.join(knowledgeRoot || path.join(workspace, 'knowledge'), 'manifest.yaml');
  let manifestBefore = null;
  try {
    manifestBefore = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    manifestBefore = null; // absent or unreadable — restore = delete
  }
  let indexed;
  try {
    indexed = runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log });
  } catch (err) {
    if (!flags.dryRun) {
      try {
        fs.rmSync(path.join(workspace, rel), { force: true });
      } catch {
        // best effort — a re-run reconciles the orphan
      }
      try {
        if (manifestBefore === null) fs.rmSync(manifestPath, { force: true });
        else fs.writeFileSync(manifestPath, manifestBefore, 'utf8');
      } catch {
        // best effort — `harness index` reconciles the manifest/postings
      }
    }
    return {
      pass: false,
      exitCode: 1,
      kind,
      path: null,
      indexed: null,
      blockedReason: `knowledge index rebuild failed, episode rolled back: ${err.message}`,
      nextTools: ['harness index'],
    };
  }
  return {
    pass: true,
    exitCode: 0,
    kind,
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
