import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInsightCompound } from '../compound.mjs';
import { applyOps } from './apply.mjs';
import { normalizeSlug } from './store.mjs';

/**
 * The human teaching lane: a direct claim from a person, captured as a
 * human-teaching episode and materialized into an active learning through
 * the sole-writer applyOps transaction — the same path consolidate uses.
 */
export function runRemember({ workspace, copilotHome, flags, argv, log = () => {} }) {
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
  const teachFlags = {
    ...flags,
    title: claim.slice(0, 80),
    body: claim,
    category: flags.category || 'teachings',
    claim,
    insight: true,
  };
  const episode = runInsightCompound({ workspace, copilotHome, flags: teachFlags, log, kind: 'human-teaching' });
  if (!episode.pass) return { ...episode, episodePath: episode.path, learningId: null };

  const domain = normalizeSlug(flags.domain || 'general');
  const slug = normalizeSlug(flags.trigger);
  const learningId = `${domain}/${slug}`;

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
  const ops = {
    schema: 1,
    ops: [
      {
        op: 'ADD',
        domain,
        slug,
        trigger: flags.trigger,
        body: claim,
        episodes: [{ path: episode.path, sha256, kind: 'human-teaching', plan: null }],
      },
    ],
  };
  const opsDir = path.join(workspace, '.harness');
  fs.mkdirSync(opsDir, { recursive: true });
  const opsPath = path.join(opsDir, 'remember-ops.json');
  fs.writeFileSync(opsPath, JSON.stringify(ops), 'utf8');
  const applied = applyOps({ workspace, opsPath });
  if (applied.exitCode !== 0) {
    // All-or-nothing: never leave an orphaned episode file behind on
    // rejection — a retry must not pile up dedup-suffixed episodes.
    fs.rmSync(path.join(workspace, episode.path), { force: true });
    return {
      pass: false,
      exitCode: applied.exitCode,
      episodePath: null,
      learningId: null,
      blockedReason: applied.rejected?.[0]?.reason || 'apply failed',
      nextTools: ['shorten the claim (1,200-byte learning cap) and re-run'],
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
