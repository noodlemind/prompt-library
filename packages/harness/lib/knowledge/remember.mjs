import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInsightCompound } from '../compound.mjs';
import { runIndexKnowledge } from '../index-knowledge.mjs';
import { applyOps } from './apply.mjs';
import { normalizeSlug, readStoreConfig, storeDir, listLearnings, ensureStore, readLedger, commitStore } from './store.mjs';
import { absorbHandEdits } from './admin.mjs';

/**
 * The human teaching lane: a direct claim from a person, captured as a
 * human-teaching episode and materialized into an active learning through
 * the sole-writer applyOps transaction — the same path consolidate uses.
 */
export function runRemember({ workspace, copilotHome, flags, argv, log = () => {}, home }) {
  // remember is human-direct: the human IS the approver, so 'suggest' behaves
  // like 'on' here (no --yes needed) — only off/freeze/capture-only block it.
  const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId: null,
      blockedReason: `knowledge mode is ${mode} — run: harness knowledge on`,
      nextTools: ['harness knowledge on'],
    };
  }
  // Absorb any hand edit before this teaching writes — so a re-teach
  // (SUPERSEDE, same trigger/domain) always builds on the absorbed state.
  // Advisory: never blocks remember. Skipped on dryRun — same reasoning as
  // applyOps' own absorb gate: a preview must never leave a real store
  // commit behind.
  if (!flags.dryRun) {
    try {
      absorbHandEdits({ workspace, home, log });
    } catch {
      // best effort
    }
  }
  const claim = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (!claim || !flags.trigger) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId: null,
      blockedReason: 'remember needs a claim positional and --trigger',
      nextTools: ['harness remember "<claim>" --trigger "<when it applies>"'],
    };
  }

  const domain = normalizeSlug(flags.domain || 'general');
  const slug = normalizeSlug(flags.trigger);
  const learningId = `${domain}/${slug}`;

  // A promoted learning's behavior now lives in a primitive (design §10) —
  // re-teaching the same trigger/domain would silently resurrect knowledge
  // the primitive already supersedes. Checked BEFORE runInsightCompound
  // below writes the episode file, so a block here never leaves an orphan
  // to roll back.
  const dir = storeDir(workspace, { home });
  const existingLearning = fs.existsSync(dir) ? listLearnings(dir).find((l) => l.id === learningId) : null;
  if (existingLearning?.fm.promoted_to) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId,
      blockedReason: `this claim was promoted to ${existingLearning.fm.promoted_to} — update that primitive, or re-teach under a different --trigger/--domain`,
      nextTools: [`harness learnings --why ${learningId}`],
    };
  }

  const teachFlags = {
    ...flags,
    title: claim.slice(0, 80),
    body: claim,
    category: flags.category || 'teachings',
    claim,
  };
  const episode = runInsightCompound({ workspace, copilotHome, flags: teachFlags, log, kind: 'human-teaching', home });
  if (!episode.pass) {
    return {
      pass: false,
      exitCode: episode.exitCode,
      episodePath: null,
      learningId: null,
      blockedReason: episode.blockedReason,
      nextTools: episode.nextTools,
    };
  }

  // Dry run: --dry-run means runInsightCompound reports a would-be path
  // without writing it, so reading/hashing/applying it would crash on a
  // missing file. Stop here with a well-formed, unstyled-crash-free result.
  if (flags.dryRun) {
    return {
      pass: true,
      exitCode: 0,
      episodePath: episode.path,
      learningId,
      blockedReason: null,
      dryRun: true,
      nextTools: ['re-run without --dry-run to write the episode and learning'],
    };
  }

  const text = fs.readFileSync(path.join(workspace, episode.path), 'utf8');
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');

  // Non-creating read: does this trigger/domain already have a learning?
  // applyOps rejects a colliding ADD outright (E_EXISTS) to stop a dedup
  // miss from silently overwriting an existing claim — a human re-teaching
  // the same trigger is not a dedup miss, it's deliberate, so it goes
  // through SUPERSEDE with the same domain/slug (target === new id), which
  // applyOps treats as an in-place replacement: fresh episode, source human,
  // status active, no superseded_by pointing at itself. Reuses the
  // `existingLearning` read above (runInsightCompound only writes an episode
  // doc, never the learnings store, so re-reading here would see the same
  // thing) — and applyOps' own STRENGTHEN/SUPERSEDE promoted-target check is
  // a second, defense-in-depth gate behind the early return above.
  const newEpisode = { path: episode.path, sha256, kind: 'human-teaching', plan: null };
  const op = existingLearning
    ? { op: 'SUPERSEDE', target: learningId, domain, slug, trigger: flags.trigger, body: claim, episodes: [newEpisode] }
    : { op: 'ADD', domain, slug, trigger: flags.trigger, body: claim, episodes: [newEpisode] };
  const ops = { schema: 1, ops: [op] };
  const opsDir = path.join(workspace, '.harness');
  fs.mkdirSync(opsDir, { recursive: true });
  // Unique per invocation: a fixed path here would let two concurrent
  // `remember` calls clobber each other's ops file before either reaches
  // applyOps's single-writer lock.
  const opsPath = path.join(opsDir, `remember-ops-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(opsPath, JSON.stringify(ops), 'utf8');
  let applied;
  try {
    applied = applyOps({ workspace, opsPath, dryRun: flags.dryRun, home, approve: true, log, copilotHome });
  } finally {
    fs.rmSync(opsPath, { force: true });
  }
  if (applied.exitCode !== 0) {
    // All-or-nothing: never leave an orphaned episode file behind on
    // rejection — a retry must not pile up dedup-suffixed episodes.
    fs.rmSync(path.join(workspace, episode.path), { force: true });
    // applyOps already recorded a failure (and possibly a quarantine) strike
    // against this episode's path before returning a non-zero exitCode
    // (recordContentFailure runs inside applyOps itself, ahead of the check
    // above) — with the episode file now rolled back, those ledger entries
    // would point at a path that no longer exists, phantom-quarantining a
    // path a human never gets to retry. Same path-filter idiom purgeEpisode
    // uses (admin.mjs): drop every ledger entry for this path and rewrite
    // consolidated.jsonl, committing the rewrite when the store has git.
    // Best effort — a cleanup failure must never mask the original rejection.
    try {
      const { dir, git } = ensureStore(workspace, { home });
      const ledger = readLedger(dir);
      const keptLedger = ledger.filter((e) => e.path !== episode.path);
      if (keptLedger.length !== ledger.length) {
        fs.writeFileSync(
          path.join(dir, 'consolidated.jsonl'),
          keptLedger.length ? keptLedger.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
          'utf8'
        );
        if (git) commitStore(dir, `remember: clear failure bookkeeping for ${episode.path}`);
      }
    } catch {
      // best effort — a ledger-cleanup failure must never mask the original rejection.
    }
    // The pre-apply runInsightCompound call above already indexed the episode
    // into the manifest/postings; without a reindex here the rolled-back file
    // would keep dangling in the manifest until the next rebuild. Same call
    // shape runInsightCompound uses — advisory only, a failed reindex must
    // never turn a clean rollback into a hard failure.
    try {
      const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
        ? path.join(copilotHome, 'knowledge')
        : null;
      runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log });
    } catch {
      // advisory reindex — the rollback itself already succeeded
    }
    // The byte-cap hint is only correct for a byte-cap rejection — every
    // other applyOps rejection (a disputed/inactive/promoted target, a
    // secret-shaped or lint-rejected claim, ...) already surfaces its own
    // real reason via blockedReason above, so a hardcoded byte-cap nextTools
    // hint would be actively misleading there. Only render it when the
    // rejection actually was the byte cap.
    return {
      pass: false,
      exitCode: applied.exitCode,
      episodePath: null,
      learningId: null,
      blockedReason: applied.rejected?.[0]?.reason || 'apply failed',
      nextTools:
        applied.rejected?.[0]?.code === 'E_BYTE_CAP' ? ['shorten the claim (1,200-byte learning cap) and re-run'] : [],
    };
  }
  return {
    pass: true,
    exitCode: 0,
    episodePath: episode.path,
    learningId,
    blockedReason: null,
    nextTools: ['harness learnings ' + domain],
  };
}
