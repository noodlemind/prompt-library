import path from 'node:path';
import { inspectSourceFile } from '../repo-map/scan.mjs';

export const APPLICABILITY_VERSION = 1;
export const MAX_SOURCE_BINDINGS = 8;
const HASH = /^[a-f0-9]{64}$/;
const semantics = 'source-bindings-only';

function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\\:\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value && value !== '.' && !value.startsWith('../');
}

/** Capture selected current bytes, not a proof that a claim remains correct. */
export function captureSourceBindings({ workspace, paths = [] }) {
  return [...new Set(Array.isArray(paths) ? paths : [])].slice(0, MAX_SOURCE_BINDINGS).map(source => {
    const input = relativePath(source) ? inspectSourceFile(workspace, source) : { state: 'excluded' };
    return { path: source, sha256: input.hash || null };
  });
}

/** Optional additive frontmatter. Omission preserves legacy learning bytes. */
export function applicabilityLines(fm) {
  if (fm.applicability_version === undefined && fm.source_bindings === undefined) return [];
  const quote = value => JSON.stringify(String(value ?? ''));
  const lines = [`applicability_version: ${quote(fm.applicability_version ?? '')}`];
  if (!Array.isArray(fm.source_bindings)) {
    lines.push(`source_bindings: ${quote(fm.source_bindings ?? '')}`);
    return lines;
  }
  if (!fm.source_bindings.length) return [...lines, 'source_bindings: []'];
  lines.push('source_bindings:');
  for (const binding of fm.source_bindings) {
    lines.push(`  - path: ${quote(binding?.path)}`, `    sha256: ${binding?.sha256 == null ? 'null' : quote(binding.sha256)}`);
  }
  return lines;
}

/** Source identities are bounded bookkeeping, not additional claim prose.
 * Discount only the supported machine shape: at most eight relative paths of
 * 512 characters with fixed-size hashes (or an unavailable marker). Malformed
 * and future formats retain the ordinary budget. Store I/O bounds still apply.
 */
export function applicabilityBytes(fm) {
  if (sourceBindingProblem(fm, { allowUnavailable: true })) return 0;
  return applicabilityLines(fm).reduce((bytes, line) => bytes + Buffer.byteLength(line, 'utf8') + 1, 0);
}

function sourceBindingProblem(fm, { allowUnavailable = false } = {}) {
  if (String(fm?.applicability_version) !== String(APPLICABILITY_VERSION)) return 'source-bindings-unavailable';
  const selected = fm.source_bindings;
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_SOURCE_BINDINGS) return 'source-bindings-unavailable';
  if (selected.some(binding => !binding || !relativePath(binding.path)
    || (!(allowUnavailable && binding.sha256 === null) && (typeof binding.sha256 !== 'string' || !HASH.test(binding.sha256))))) return 'invalid-source-binding';
  const paths = new Set(selected.map(binding => binding.path));
  if (paths.size !== selected.length) return 'duplicate-source-binding';
  const anchors = Array.isArray(fm.anchors) ? fm.anchors : [];
  if (anchors.length !== selected.length || new Set(anchors).size !== anchors.length || anchors.some(anchor => !paths.has(anchor))) return 'anchor-binding-mismatch';
  return null;
}

/** A safe supported binding shape can replace the old cached anchor policy.
 * Currentness still requires a live comparison in learningApplicability.
 */
export function hasSourceIdentityBindings(fm) {
  return sourceBindingProblem(fm) === null;
}

/** Live, bounded source comparison. State never changes claim status or proof. */
export function learningApplicability({ workspace, fm, repository, cache = new Map() }) {
  const unknown = reason => ({ state: 'unknown', semantics, reason, bindings: [] });
  if (String(fm?.applicability_version) !== String(APPLICABILITY_VERSION)) return unknown('source-bindings-unavailable');
  if (typeof repository !== 'string' || !repository || fm.origin !== repository) return unknown('different-repository');
  const problem = sourceBindingProblem(fm);
  if (problem) return unknown(problem);
  const bindings = fm.source_bindings.map(binding => {
    if (!cache.has(binding.path)) {
      const { state, hash } = inspectSourceFile(workspace, binding.path);
      cache.set(binding.path, { state, hash });
    }
    const input = cache.get(binding.path);
    if (input.state === 'readable') {
      return { path: binding.path, sha256: binding.sha256, currentSha256: input.hash,
        state: input.hash === binding.sha256 ? 'unchanged' : 'changed',
        reason: input.hash === binding.sha256 ? null : 'source-changed' };
    }
    return { path: binding.path, sha256: binding.sha256, state: input.state,
      reason: input.state === 'missing' ? 'source-missing' : input.state === 'excluded' ? 'source-unsafe' : 'source-unavailable' };
  });
  const changed = bindings.some(binding => ['changed', 'missing', 'excluded'].includes(binding.state));
  const unavailable = bindings.some(binding => binding.reason === 'source-unavailable');
  return { state: changed ? 'needs-review' : unavailable ? 'unknown' : 'current', semantics,
    reason: changed ? 'source-bindings-changed' : unavailable ? 'source-unavailable' : 'source-bindings-unchanged', bindings };
}
