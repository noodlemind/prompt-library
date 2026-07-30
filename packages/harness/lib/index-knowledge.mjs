import fs from 'fs';
import path from 'path';
import { runBuildPostingsIndex } from './postings-index.mjs';
import { resolveIndexDir } from './recall-config.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function summaryFromBody(text) {
  const prob = text.match(/## Problem\s*\n+([^\n#]+)/i);
  if (prob) return prob[1].trim().slice(0, 200);
  return (
    text
      .replace(/^---[\s\S]*?---\n/, '')
      .trim()
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 200) || ''
  );
}

function excerptFromBody(text) {
  const body = text.replace(/^---[\s\S]*?---\n/, '').trim();
  const prob = body.match(/## Problem\s*\n+([\s\S]*?)(?=\n## |\n# |$)/i);
  const source = prob ? prob[1].trim() : body;
  return source.replace(/\s+/g, ' ').slice(0, 400);
}

function yamlQuote(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Same physical-containment pattern collectEpisodes (consolidate.mjs) uses:
 * every candidate — the scanned root directory itself, each category
 * directory, and each file — is validated with assertNoSymlinkAncestors
 * (fs-safe.mjs) against `base`, never trusted merely because it was
 * lexically reachable under `dir`. This manifest builder reads the SAME
 * docs/solutions trees collectEpisodes scans and feeds title/summary/
 * excerpt straight into recall's manifest — a symlinked docs/solutions (or a
 * symlinked category directory) previously had no containment check at all
 * here, not even a lexical one, and would leak outside file content into the
 * manifest the same way collectEpisodes did before it was hardened.
 */
function collectSolutions(dir, scope, base) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  const dirRel = path.relative(base, dir);
  if (!assertNoSymlinkAncestors(base, dirRel)) return entries;
  for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    const catRel = path.join(dirRel, cat.name);
    if (!assertNoSymlinkAncestors(base, catRel)) continue; // symlinked category directory
    const catPath = path.join(dir, cat.name);
    for (const f of fs.readdirSync(catPath)) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const fileRel = path.join(catRel, f);
      const full = assertNoSymlinkAncestors(base, fileRel);
      if (!full) continue; // symlinked leaf (or any ancestor) — never follow
      const text = readFileNoFollow(full);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const rel = fileRel.split(path.sep).join('/');
      const slug = f.replace(/\.md$/, '');
      const entryId = `${scope}-${cat.name}-${slug}`;
      entries.push({
        id: entryId,
        docid: entryId,
        kind: fm.kind === 'insight' ? 'insight' : 'solution',
        scope,
        path: rel,
        title: fm.title || slug,
        category: fm.category || cat.name,
        tags: fm.tags ? fm.tags.split(',').map((t) => t.trim()) : [],
        module: fm.module || '',
        symptom: fm.symptom || '',
        trigger: fm.trigger || '',
        claim: fm.claim || '',
        summary: summaryFromBody(text),
        excerpt: excerptFromBody(text),
        date: fm.date || fm.updated || '',
        updated: fm.updated || fm.date || '',
      });
    }
  }
  return entries;
}

export function runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log }) {
  const roots = [];
  if (knowledgeRoot) {
    roots.push({
      dir: path.join(knowledgeRoot, 'solutions'),
      scope: 'global',
      base: knowledgeRoot,
    });
  }
  const productSol = path.join(workspace, 'docs', 'solutions');
  if (fs.existsSync(productSol)) {
    roots.push({ dir: productSol, scope: 'product', base: workspace });
  }

  let entries = [];
  for (const { dir, scope, base } of roots) {
    entries = entries.concat(collectSolutions(dir, scope, base));
  }

  const seenIds = new Set();
  for (const e of entries) {
    if (seenIds.has(e.id)) {
      throw new Error(`duplicate manifest id "${e.id}" — paths collide across knowledge roots`);
    }
    seenIds.add(e.id);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const manifestPath = path.join(knowledgeRoot || path.join(workspace, 'knowledge'), 'manifest.yaml');
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Team knowledge index — rebuilt by harness index',
    'version: 1',
    `updated: ${today}`,
    'entries:',
  ];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    docid: ${e.docid}`);
    lines.push(`    kind: ${e.kind}`);
    lines.push(`    scope: ${e.scope}`);
    lines.push(`    path: ${e.path}`);
    lines.push(`    title: ${yamlQuote(e.title)}`);
    lines.push(`    category: ${e.category}`);
    if (e.tags?.length) lines.push(`    tags: [${e.tags.map((t) => yamlQuote(t)).join(', ')}]`);
    if (e.module) lines.push(`    module: ${yamlQuote(e.module)}`);
    if (e.symptom) lines.push(`    symptom: ${yamlQuote(e.symptom)}`);
    if (e.trigger) lines.push(`    trigger: ${yamlQuote(e.trigger)}`);
    if (e.claim) lines.push(`    claim: ${yamlQuote(e.claim)}`);
    if (e.date) lines.push(`    date: ${e.date}`);
    if (e.summary) lines.push(`    summary: ${yamlQuote(e.summary)}`);
    if (e.excerpt) lines.push(`    excerpt: ${yamlQuote(e.excerpt)}`);
  }

  const body = lines.join('\n') + '\n';
  if (flags.dryRun) {
    log(`would write ${manifestPath} (${entries.length} entries)`);
    const indexDir = resolveIndexDir(copilotHome || '', workspace);
    runBuildPostingsIndex({ entries, indexDir, manifestUpdated: today, flags });
    log(`would write ${indexDir} (${entries.length} postings)`);
    return { entries: entries.length, manifestPath, indexDir };
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, body, 'utf8');
  log(`wrote ${manifestPath} (${entries.length} entries)`);

  const indexDir = resolveIndexDir(copilotHome || '', workspace);
  const indexResult = runBuildPostingsIndex({
    entries,
    indexDir,
    manifestUpdated: today,
    flags,
  });
  log(`wrote ${indexDir} (${indexResult.entryCount} postings)`);

  return { entries: entries.length, manifestPath, indexDir, indexEntries: indexResult.entryCount };
}
