import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { harnessGlobalHome } from '../paths.mjs';

/**
 * The local knowledge store: a CLI-managed git repo OUTSIDE the working tree
 * at <harness home>/knowledge/<repo-id>/ — survives `git clean`, re-clones,
 * and is shared by every worktree/clone of the same remote. Never pushed.
 */

const INDEX_STUB = `# Learnings Index

_Rebuilt by \`harness consolidate --apply\`. One line per active learning._
`;

function gitOut(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Normalize any origin-remote form (ssh/https/scp) to one stable id. The
 * human-readable slug alone is lossy — `github.com/org-a/repo-b` and
 * `github.com/org-a-repo/b` both collapse to the same slug once `/` and `-`
 * are folded together — so a short hash of the pre-lossy canonical string is
 * appended to disambiguate. Equivalent ssh/https/scp forms of the same
 * remote still share one canonical string, so they still share one id.
 */
export function repoId(workspace) {
  const remote = gitOut(workspace, ['remote', 'get-url', 'origin']);
  if (remote) {
    const canonical = remote
      .trim()
      .replace(/\.git$/, '')
      .replace(/^[a-z+]+:\/\//i, '') // https://, ssh://, git://
      .replace(/^[^@/]+@/, '') // user@
      .replace(/:/g, '/') // scp form host:path
      .toLowerCase();
    const slug = canonical.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      const suffix = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
      return `${slug}-${suffix}`;
    }
  }
  // No remote: stable path-keyed fallback (documented limitation — memory is
  // per-path until a remote is added).
  let real = workspace;
  try {
    real = fs.realpathSync(workspace);
  } catch {
    // keep the given path
  }
  return `local-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

export function storeDir(workspace, { home } = {}) {
  return path.join(home || harnessGlobalHome(), 'knowledge', repoId(workspace));
}

export function ensureStore(workspace, { home, dryRun = false } = {}) {
  const dir = storeDir(workspace, { home });
  const created = !fs.existsSync(path.join(dir, 'consolidated.jsonl'));
  if (dryRun) return { dir, created, git: fs.existsSync(path.join(dir, '.git')) };
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  let gitOk = fs.existsSync(path.join(dir, '.git'));
  if (!gitOk) {
    gitOk = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status === 0;
  }
  const indexPath = path.join(dir, 'INDEX.md');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, INDEX_STUB, 'utf8');
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, '', 'utf8');
  return { dir, created, git: gitOk };
}

const KNOWLEDGE_MODES = new Set(['on', 'off', 'freeze', 'capture-only']);

/**
 * Kill-switch mode for the knowledge layer, read from <store>/config.json.
 * Read-only — never creates the store. Tolerant of an absent or corrupt
 * config (missing file, unreadable JSON, unrecognized mode): default is 'on'
 * so a fresh or damaged store never silently blocks the whole layer.
 */
export function readStoreConfig(workspace, { home } = {}) {
  const dir = storeDir(workspace, { home });
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (parsed && KNOWLEDGE_MODES.has(parsed.mode)) return { mode: parsed.mode };
  } catch {
    // absent, unreadable, or corrupt — default mode is 'on'
  }
  return { mode: 'on' };
}

export function writeStoreConfig(workspace, { home, mode } = {}) {
  const { dir } = ensureStore(workspace, { home });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode }) + '\n', 'utf8');
  const { committed } = commitStore(dir, `knowledge: mode ${mode}`);
  return { mode, committed };
}

/** Append-only episode-consumption ledger. Torn tail lines are tolerated. */
export function readLedger(dir) {
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  if (!fs.existsSync(ledgerPath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn/corrupt line — skip, never fail reads on it
    }
  }
  return entries;
}

export function appendLedger(dir, entries) {
  const ledgerPath = path.join(dir, 'consolidated.jsonl');
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ledgerPath, prefix + entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Parse learning frontmatter including the structured episodes block and the
 * flat anchors list. Only one list can be "open" at a time — episodes and
 * anchors items look similar (both start `  - `) so we track which block
 * we're inside and only apply that block's item shape.
 */
export function parseLearningFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm = { episodes: [], anchors: [] };
  let openList = null; // 'episodes' | 'anchors' | null
  let current = null;
  for (const line of m[1].split('\n')) {
    if (/^episodes:\s*$/.test(line)) {
      openList = 'episodes';
      current = null;
      continue;
    }
    if (/^anchors:\s*\[\]\s*$/.test(line)) {
      openList = null;
      current = null;
      fm.anchors = [];
      continue;
    }
    if (/^anchors:\s*$/.test(line)) {
      openList = 'anchors';
      current = null;
      continue;
    }
    if (openList === 'episodes') {
      const item = line.match(/^\s{2}- (\w+):\s*(.*)$/);
      const sub = line.match(/^\s{4}(\w+):\s*(.*)$/);
      if (item) {
        current = { [item[1]]: unquote(item[2]) };
        fm.episodes.push(current);
        continue;
      }
      if (sub && current) {
        current[sub[1]] = unquote(sub[2]);
        continue;
      }
    }
    if (openList === 'anchors') {
      const anchorItem = line.match(/^\s{2}- (.+)$/);
      if (anchorItem) {
        fm.anchors.push(unquote(anchorItem[1]));
        continue;
      }
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      openList = null;
      current = null;
      const value = unquote(kv[2]);
      fm[kv[1]] = value === 'null' || value === '' ? (value === '' ? '' : null) : value;
    }
  }
  const body = text.slice(m[0].length).trim();
  return { fm, body };
}

const ESCAPE_MAP = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Reverse what `yamlQuote` does at write time: wrap in double quotes, then
 * escape `\`, `"`, and control chars. Only a value surrounded by
 * double quotes on both ends went through that escaping, so only that shape
 * gets unescaped — a single-pass regex so a real backslash (encoded as
 * `\\`) is never re-interpreted as the start of a second escape sequence.
 * Anything else (bare scalars, single-quoted legacy values) is only
 * quote-stripped, exactly as before.
 */
function unquote(v) {
  const s = String(v ?? '').trim();
  const m = /^"([\s\S]*)"$/.exec(s);
  if (m) {
    return m[1].replace(/\\(.)/g, (_, ch) => ESCAPE_MAP[ch] ?? ch);
  }
  return s.replace(/^["']|["']$/g, '');
}

export function listLearnings(dir) {
  const root = path.join(dir, 'learnings');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const domain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const dPath = path.join(root, domain.name);
    for (const f of fs.readdirSync(dPath)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(dPath, f);
      const text = fs.readFileSync(file, 'utf8');
      const { fm, body } = parseLearningFrontmatter(text);
      const slug = f.replace(/\.md$/, '');
      out.push({
        id: `${domain.name}/${slug}`,
        domain: domain.name,
        slug,
        file,
        fm,
        body,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Commit everything in the store; false when the tree is clean. */
export function commitStore(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  const res = spawnSync(
    'git',
    ['-c', 'user.name=harness', '-c', 'user.email=harness@local', 'commit', '-q', '-m', message],
    { cwd: dir, encoding: 'utf8' }
  );
  return { committed: res.status === 0 };
}

/** Lowercase, diacritic-stripped, [a-z0-9-] slugs — case-insensitive-FS safe. */
export function normalizeSlug(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'learning'
  );
}

/**
 * Stale-anchor exclusions: CLI state recomputed by `harness index`, not a
 * learning write. Tolerant of an absent or corrupt file — a fresh or damaged
 * store never blocks retrieval.
 */
export function readStaleExclusions(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'stale.json'), 'utf8'));
    if (parsed && parsed.excluded && typeof parsed.excluded === 'object') {
      return { excluded: parsed.excluded };
    }
  } catch {
    // absent, unreadable, or corrupt — tolerant default
  }
  return { excluded: {} };
}

export function writeStaleExclusions(dir, data) {
  fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify(data) + '\n', 'utf8');
}
