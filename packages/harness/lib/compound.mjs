import fs from 'fs';
import path from 'path';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { resolveIndexDir } from './recall-config.mjs';
import { readSession, writeSession } from './session.mjs';
import { readEvidence, validateEvidence } from './evidence.mjs';
import { selectPlan } from './plan-parse.mjs';
import { loadPolicy } from './policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { recordSkillUsage } from './telemetry.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { deriveGitContext } from './git-context.mjs';
import { assertNoSymlinkAncestors, realpathParentContained } from './fs-safe.mjs';

function snapshotFile(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
function restoreFile(p, snap) {
  try {
    if (snap === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, snap);
  } catch {
    // best effort — `harness index` reconciles retrieval state on the next run
  }
}

function snapshotRestored(p, snap) {
  try {
    if (snap === null) return !fs.existsSync(p);
    return fs.readFileSync(p).equals(snap);
  } catch {
    return false;
  }
}

function reserveEpisodePath(workspace, dirRel, base, doc) {
  const dirFull = assertNoSymlinkAncestors(workspace, dirRel);
  if (!dirFull) return { ok: false };
  fs.mkdirSync(dirFull, { recursive: true });
  let candidate = `${base}.md`;
  let n = 2;
    for (let attempt = 0; attempt < 100000; attempt++) {
    const rel = path.join(dirRel, candidate);
    const full = assertNoSymlinkAncestors(workspace, rel);
    if (!full) return { ok: false };
    try {
            const fd = fs.openSync(full, 'wx');
            if (!realpathParentContained(workspace, full)) {
        try {
          fs.closeSync(fd);
        } catch {
          // fd may already be gone if the leaf was swapped away
        }
        try {
          fs.unlinkSync(full);
        } catch {
          // best effort — a swapped-away leaf is not ours to chase
        }
        return { ok: false };
      }
      // Verify passed: write the content THROUGH the verified descriptor.
      try {
        fs.writeFileSync(fd, doc);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, rel };
    } catch (err) {
      if (err.code === 'EEXIST') {
        candidate = `${base}-${n}.md`;
        n += 1;
        continue;
      }
      return { ok: false, error: err };
    }
  }
  return { ok: false };
}

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
  // The one-liner form is the contract the approved TUI mock shows in its own
  // composer example: `compound --insight "windows taskkill needs its own
  // probe"`. When the insight text is all there is, it IS the title and the
  // body — demanding both separately for a one-sentence observation turned a
  // capture affordance into a form.
  const insightText = typeof flags.insight === 'string' ? flags.insight.trim() : '';
  const title = flags.title || (insightText.length > 3 ? insightText.slice(0, 96) : '');
  const body = flags.body
    || (flags.bodyFile ? fs.readFileSync(path.resolve(flags.bodyFile), 'utf8') : '')
    || (flags.title ? '' : insightText);
  if (!title || !body.trim()) {
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
  const fmLines = [`title: ${yamlQuote(title)}`, `kind: ${kind}`, `date: ${date}`];
  if (tags) fmLines.push(`tags: ${tags}`);
  if (flags.trigger) fmLines.push(`trigger: ${yamlQuote(flags.trigger)}`);
  if (flags.claim) fmLines.push(`claim: ${yamlQuote(flags.claim)}`);
  // Git provenance (blueprint P1/P9): optional commit/branch/base stamped at
  // capture time from the CURRENT workspace HEAD. This is the sole CLI
  // episode writer — `compound --insight` (kind: insight) and
  // `harness remember` (kind: human-teaching) both land here — so every
  // CLI-captured episode carries provenance; skill-authored fix episodes stay
  // reader-tolerant (absent fields are fine everywhere). Shas are stamped
  // bare; the branch name is attacker-influenced text on fork checkouts, so
  // it rides through yamlQuote like every other quoted field here.
  const gitContext = deriveGitContext({ workspace, home });
  if (gitContext.headSha) fmLines.push(`commit: ${gitContext.headSha}`);
  if (gitContext.branch) fmLines.push(`branch: ${yamlQuote(gitContext.branch)}`);
  if (gitContext.baseSha) fmLines.push(`base: ${gitContext.baseSha}`);
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
  const base = `${date}-${slugify(title)}`;
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
  let rel;
  if (flags.dryRun) {
    // Dry run writes nothing, so a plain existence probe is enough to report a
    // representative would-be name (no reservation, no file created).
    rel = path.join(dirRel, `${base}.md`);
    let n = 2;
    while (fs.existsSync(path.join(workspace, rel))) {
      rel = path.join(dirRel, `${base}-${n}.md`);
      n += 1;
    }
  } else {
    // Atomic exclusive-create reservation (P1#1): claims a unique suffix with
    // O_EXCL so concurrent captures of the same title can never overwrite each
    // other. Containment is re-validated before each create.
    const reserved = reserveEpisodePath(workspace, dirRel, base, doc);
    if (!reserved.ok) {
      return {
        pass: false,
        exitCode: 1,
        kind,
        path: null,
        indexed: null,
        blockedReason: reserved.error
          ? `could not write episode file: ${reserved.error.message}`
          : 'episode path escapes the workspace (symlinked docs/solutions?)',
        nextTools: ['remove or replace the symlinked docs/solutions directory and re-run'],
      };
    }
    rel = reserved.rel;
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
  // never reaches `if (!episode.pass)`). Snapshot the ENTIRE retrieval state it
  // writes — the manifest AND the postings (index-knowledge writes manifest
  // then postings.json/meta.json, so a throw between them can leave postings
  // referencing the rolled-back episode) — and on any index failure delete the
  // just-written episode and restore all of it so retrieval state is exactly
  // pre-write, then return a clean, recoverable failure the caller handles.
  const manifestPath = path.join(knowledgeRoot || path.join(workspace, 'knowledge'), 'manifest.yaml');
  const indexDir = resolveIndexDir(copilotHome || '', workspace);
  const snapshots = [
    [manifestPath, snapshotFile(manifestPath)],
    [path.join(indexDir, 'postings.json'), snapshotFile(path.join(indexDir, 'postings.json'))],
    [path.join(indexDir, 'meta.json'), snapshotFile(path.join(indexDir, 'meta.json'))],
  ];
  let indexed;
  try {
    indexed = runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log });
  } catch (err) {
    // Rollback WITH verified postconditions (P2): the prior code swallowed
    // every recovery error yet always reported "episode rolled back" /
    // `path: null` — so a rollback that left the episode on disk or failed to
    // restore retrieval state was indistinguishable from a clean one. Now each
    // step is verified against disk and any residue is named in the result.
    const episodeFull = path.join(workspace, rel);
    let episodeRemains = false;
    const unrestored = [];
    if (!flags.dryRun) {
      try {
        fs.rmSync(episodeFull, { force: true });
      } catch {
        // best effort — verified below regardless of whether rmSync threw
      }
      episodeRemains = fs.existsSync(episodeFull);
      // Restore manifest + postings + meta to exactly pre-write (write back the
      // snapshot, or delete if it was absent), then confirm each landed.
      for (const [p, snap] of snapshots) {
        restoreFile(p, snap);
        if (!snapshotRestored(p, snap)) unrestored.push(p);
      }
    }
    const recovered = !episodeRemains && unrestored.length === 0;
    let blockedReason;
    if (recovered) {
      blockedReason = `knowledge index rebuild failed, episode rolled back: ${err.message}`;
    } else {
      const residue = [];
      if (episodeRemains) residue.push(`episode still on disk at ${rel.split(path.sep).join('/')}`);
      if (unrestored.length) residue.push(`retrieval state not restored: ${unrestored.join(', ')}`);
      blockedReason = `knowledge index rebuild failed AND rollback incomplete (${residue.join('; ')}) — run: harness index. Original error: ${err.message}`;
    }
    return {
      pass: false,
      exitCode: 1,
      kind,
      path: null,
      indexed: null,
      blockedReason,
      // Name the residue explicitly so a caller never treats a partial
      // recovery as a clean one.
      ...(recovered ? {} : { partialRecovery: { episodeRemains, unrestored } }),
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
    maxAgeHours: loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome) }).evidenceTtlHours,
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
