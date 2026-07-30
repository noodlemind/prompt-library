// Best-effort credential screening for knowledge capture and learning writes.
// Regex-grade by design — documented as screening, never prevention. The real
// backstop is the never-pushed local knowledge store.
const PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    id: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { id: 'connection-string', re: /\b\w+:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: 'generic-api-key',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_\-/+]{20,}["']?/i,
  },
];

export function scanSecrets(text) {
  const hits = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      if (re.test(lines[i])) hits.push({ id, line: i + 1 });
    }
  }
  return hits;
}

/**
 * Best-effort secret screen for a single rendered field (sweep P3): the recall/
 * manifest ingestion path never ran scanSecrets, so a credential committed into
 * a manifest title/snippet or a hand-authored solution doc could surface
 * verbatim on the agent-facing context pack and `harness recall`. On any hit,
 * return a marker naming the matched pattern(s) INSTEAD of the field's content,
 * so the secret is never rendered. Same regex-grade caveat as scanSecrets
 * itself — screening, not prevention; the never-pushed out-of-tree store stays
 * the real backstop (documented residual #5).
 */
export function redactSecrets(text) {
  const s = String(text ?? '');
  const hits = scanSecrets(s);
  if (!hits.length) return s;
  return `[redacted: ${[...new Set(hits.map((h) => h.id))].join(', ')}]`;
}

// The untrusted, repo/manifest-derived free-text fields of a built recall
// entry. Each can carry a pasted credential — a `path` with an embedded
// connection string, a secret-shaped `docid`, or a secret in `title`/
// `summary`/`snippet` prose. Redacting them HERE, at the DATA boundary where
// the recall result object is constructed, is the single guarantee that
// reaches EVERY consumer at once: the rendered context pack, `harness recall`,
// AND their `--json` siblings. A render-boundary-only screen missed both the
// raw `--json` emit and the `path`/`docid` fields entirely (reproduced leaks).
// `scope`/`kind`/`ranker`/`score` are code-set classification/enum/number
// tokens, not free-text credential carriers, so they are left untouched — and
// a legitimate path (no `://` connection string or AWS-key shape) never
// matches, so this cannot corrupt normal paths.
const RECALL_UNTRUSTED_STRING_FIELDS = ['docid', 'path', 'title', 'summary', 'snippet'];

export function redactRecallEntry(entry) {
  const redacted = { ...entry };
  for (const field of RECALL_UNTRUSTED_STRING_FIELDS) {
    const value = redacted[field];
    if (typeof value === 'string' && value) redacted[field] = redactSecrets(value);
  }
  return redacted;
}
