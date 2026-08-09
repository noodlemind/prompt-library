import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readSession } from './session.mjs';
import { selectPlan } from './plan-parse.mjs';
import { extractAcceptanceCriteria, validatePlanSchema } from './plan-schema.mjs';
import { validatePlanScope } from './plan-scope.mjs';
import { createEvidenceBinding, writeEvidence } from './evidence.mjs';
import { checkSeverityFor, enforcementExitCode, loadPolicy } from './policy.mjs';
import { resolveCopilotHome } from './paths.mjs';
import { verifyPrimitiveGovernance } from './primitive-governance.mjs';
import { validatePlanReadiness } from './plan-readiness.mjs';
import { STRUCTURAL_CHECK_ID, runStructuralExpectations } from './structural/expectations.mjs';
import { redactSecrets } from './secret-scan.mjs';
import { inertLine } from './knowledge/store.mjs';
// Phase 3 prerequisite: the named-check config surface moved to lib/checks.mjs
// so `checks list/show/run` can share it. Behavior here is unchanged — this is
// the same loader, validator, and runner verify has always used.
import { CHECKS_REL, loadNamedChecks, validateCommand, runNamedCheck } from './checks.mjs';
import { createRedactor, redactionMarker } from './redact.mjs';


// Built-in default severities. Any check without a policy entry and without a
// default here is `enforce` — exactly the pre-severity behavior.
const DEFAULT_CHECK_SEVERITIES = { [STRUCTURAL_CHECK_ID]: 'advisory' };

function resultCheck(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}




// P1.6 (AC8): named checks now run through lib/runner.mjs's async spawn
// instead of a blocking spawnSync — the same 1 MiB buffer cap as before, plus
// an optional caller-supplied AbortSignal so a check-in-flight can actually
// be cancelled (Ctrl-C -> SIGINT -> AbortSignal, wired in bin/harness.mjs for
// `verify` only). The legacy per-check `status` vocabulary
// (passed|failed|timeout|unavailable) is preserved byte-for-byte for every
// outcome the old spawnSync path could produce; `runProcess`'s
// 'cancelled' status is new (spawnSync had no cancellation concept) and maps
// to 'unavailable' here — the run-level short-circuit in runVerify (see
// below) is what actually matters for AC8, not this one check's own legacy
// status label.

// Fix-wave Important #9 (AC8): live check-output streaming for `verify
// --output jsonl`. Pre-fix, runNamedCheck supplied no onStdout/onStderr, so
// the stream emitted a start marker and then only the terminal status —
// check output was never streamed at all. This streamer turns a check's raw
// chunk stream into bounded, REDACTED, line-per-row `onEvent('row', {check,
// stream, line})` events:
//
//   - Carry buffer per stream: chunks accumulate until a newline, so a
//     secret split across two chunk boundaries WITHIN a line is reassembled
//     before redaction and can't evade the masking pass.
//   - Block-aware (fix-wave P1, multi-line PEM): redactText's PEM pattern
//     needs a whole BEGIN..END block, but streaming splits it into per-line
//     rows before redaction — so a 3-line key used to stream out raw, one
//     unmasked line per row. This streamer now HOLDS every line from a
//     `-----BEGIN … PRIVATE KEY-----` opener until its matching END footer
//     (bounded) and masks the whole block as one `«redacted:private-key»`
//     row, independent of redactText's own (length-bounded) PEM match. A
//     secret spanning a newline that is NOT a PEM block remains outside a
//     single-line redactor's reach — the same documented ceiling as
//     lib/redact.mjs — but the highest-value multi-line secret (a private
//     key) is now caught structurally.
//   - Bounded: at most `maxBytes` of emitted output per check, measured as the
//     bytes actually written — each row's full serialized width (content AND
//     JSON envelope AND the escaping expansion of both), with the final
//     `{truncated: true}` marker row reserved up front so it fits inside the
//     cap rather than overshooting it — and `maxLineBytes` per row. A pathological no-newline flood force-flushes the carry once it
//     exceeds the carry cap; a PEM block that overflows its hold bound without
//     an END is masked and then stays poisoned (drops raw lines) until END.
//   - Redaction runs on the assembled LINE, before the row is handed to
//     onEvent; the JSONL emitter's own row-level redaction (lib/envelope.mjs,
//     fix C2) remains as defense in depth behind it.
export const STREAM_MAX_BYTES_PER_CHECK = 16 * 1024;
export const STREAM_MAX_LINE_BYTES = 512;
const STREAM_CARRY_CAP_BYTES = 8 * 1024;
// A detected PEM block is held (not emitted) from its BEGIN line until the
// matching END so the WHOLE multi-line secret is masked as a unit. Bound the
// held bytes so a lone BEGIN — or an attacker flooding one — can't buffer
// without limit; comfortably larger than any real private key (RSA-8192 is
// ~6.5 KiB of base64).
const STREAM_BLOCK_MAX_BYTES = 16 * 1024;

// Broad on purpose (any `-----BEGIN <words> PRIVATE KEY-----` / END form),
// wider than redact.mjs's enumerated key types, so a novel key label can't
// slip the structural hold.
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export function createCheckOutputStreamer({ check, onEvent, redactText, maxBytes = STREAM_MAX_BYTES_PER_CHECK, maxLineBytes = STREAM_MAX_LINE_BYTES }) {
  const PRIVATE_KEY_MASK = redactionMarker('private-key');
  // Per-stream state: partial-line carry plus the multi-line PEM hold.
  const state = {
    stdout: { carry: '', blockOpen: false, blockLines: [], blockBytes: 0, blockMasked: false },
    stderr: { carry: '', blockOpen: false, blockLines: [], blockBytes: 0, blockMasked: false },
  };
  // Exact serialized cost of one emitted row: the bytes lib/envelope.mjs will
  // actually write for it (`{schema, event, ...fields}`, newline-terminated).
  //
  // Round 2: this used to be `raw line bytes + the envelope measured around an
  // EMPTY line`, which prices every character JSON escaping expands at its
  // pre-escape width — `\` and `"` double, a control byte becomes a 6-byte
  // \\uXXXX. Backslash-heavy output could therefore write ~2x maxBytes while
  // the counter still read under budget. Serializing the real payload prices
  // the escaping exactly, so the cap holds for adversarial content too.
  function rowBytes(payload) {
    return Buffer.byteLength(JSON.stringify({ schema: 1, event: 'row', ...payload }), 'utf8') + 1;
  }
  // The truncation marker is emitted output as well, so its cost is reserved up
  // front rather than charged after the fact — otherwise the very row that
  // trips the cut pushes the total past maxBytes by the marker's width. Both
  // stream names are the same length today; take the max so that stays true.
  const markerBytes = Math.max(
    rowBytes({ check, stream: 'stdout', truncated: true }),
    rowBytes({ check, stream: 'stderr', truncated: true }),
  );
  let emittedBytes = 0;
  let truncated = false;

  function clipToBytes(text, cap) {
    if (Buffer.byteLength(text, 'utf8') <= cap) return text;
    // Walk whole code points once (O(n), never the old O(n²) that recomputed
    // Buffer.byteLength over the whole string per removed UTF-16 unit),
    // accumulating UTF-8 byte cost until the next char would cross the cap.
    // Slicing on a code-point boundary never splits a surrogate pair or a
    // multibyte char, so the clipped text is always valid UTF-8.
    let bytes = 0;
    let end = 0;
    for (const ch of text) {
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (bytes + chBytes > cap) break;
      bytes += chBytes;
      end += ch.length;
    }
    return text.slice(0, end);
  }

  function budgetRow(stream, payload) {
    if (emittedBytes + rowBytes(payload) + markerBytes > maxBytes) {
      truncated = true;
      onEvent('row', { check, stream, truncated: true });
      return;
    }
    emittedBytes += rowBytes(payload);
    onEvent('row', payload);
  }

  // Emit one line as a row: redact, clip the redacted text, count the row's
  // full serialized width against the per-check budget.
  function emitLine(stream, line) {
    if (truncated || !line) return;
    const safe = clipToBytes(redactText(line), maxLineBytes);
    budgetRow(stream, { check, stream, line: safe });
  }

  // Emit a fixed private-key mask row for a structurally identified PEM block —
  // masked WHOLESALE, independent of redactText's bounded PEM pattern, because
  // the BEGIN/END delimiters have already positively identified it.
  function emitPrivateKeyMask(stream) {
    if (truncated) return;
    budgetRow(stream, { check, stream, line: PRIVATE_KEY_MASK });
  }

  function resetBlock(s) {
    s.blockOpen = false;
    s.blockLines = [];
    s.blockBytes = 0;
    s.blockMasked = false;
  }

  function closeBlock(stream) {
    const s = state[stream];
    const alreadyMasked = s.blockMasked;
    resetBlock(s);
    // Mask the whole identified block as one private-key row (unless overflow
    // already emitted the mask). Any non-secret text on the BEGIN/END lines is
    // dropped — secret safety over fidelity, the block was positively identified.
    if (!alreadyMasked) emitPrivateKeyMask(stream);
  }

  // One complete line (newline already stripped) through the PEM state machine.
  function feedLine(stream, line) {
    if (truncated) return;
    const s = state[stream];
    if (!s.blockOpen) {
      if (PEM_BEGIN_RE.test(line)) {
        // BEGIN and END on ONE line (self-contained key): mask wholesale
        // rather than trust redactText's length-bounded pattern.
        if (PEM_END_RE.test(line)) {
          emitPrivateKeyMask(stream);
          return;
        }
        s.blockOpen = true;
        s.blockLines = [line];
        s.blockBytes = Buffer.byteLength(line, 'utf8');
        s.blockMasked = false;
        return;
      }
      emitLine(stream, line);
      return;
    }
    // Inside a held block.
    s.blockBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (!s.blockMasked) s.blockLines.push(line);
    if (PEM_END_RE.test(line)) {
      closeBlock(stream);
      return;
    }
    if (s.blockBytes > STREAM_BLOCK_MAX_BYTES && !s.blockMasked) {
      // Overflowed with no END yet: emit the mask now and stay poisoned (drop
      // every further raw line) until the END arrives — never leak a key body
      // just because the block is larger than the hold bound.
      emitPrivateKeyMask(stream);
      s.blockLines = [];
      s.blockMasked = true;
    }
  }

  function push(stream, chunk) {
    if (truncated) return;
    const s = state[stream];
    s.carry += chunk;
    let idx;
    while ((idx = s.carry.indexOf('\n')) !== -1) {
      let line = s.carry.slice(0, idx);
      // A CRLF delimiter leaves its CR at the end of the line. Drop exactly the
      // one CR that belongs to the delimiter (never a bare CR the check meant
      // to emit) so a check's rows are byte-identical on Windows and POSIX —
      // otherwise every JSONL `line` gains a trailing \\r on Windows and any
      // consumer comparing rows exactly disagrees across platforms.
      if (line.endsWith('\r')) line = line.slice(0, -1);
      s.carry = s.carry.slice(idx + 1);
      feedLine(stream, line);
      if (truncated) {
        s.carry = '';
        return;
      }
    }
    if (s.carry.length > STREAM_CARRY_CAP_BYTES) {
      const line = s.carry;
      s.carry = '';
      feedLine(stream, line);
    }
  }

  function flush() {
    for (const stream of ['stdout', 'stderr']) {
      const s = state[stream];
      if (s.carry) {
        const line = s.carry;
        s.carry = '';
        feedLine(stream, line);
      }
      // An unterminated block at flush (BEGIN seen, no END): mask it, never
      // emit the held raw body.
      if (s.blockOpen) closeBlock(stream);
    }
  }

  return {
    onStdout: (chunk) => push('stdout', chunk),
    onStderr: (chunk) => push('stderr', chunk),
    flush,
  };
}

// The unified ok|failed|cancelled|timed-out status vocabulary (lib/envelope.mjs)
// for ONE named check's legacy status label — used only by the new `verify
// --output jsonl` row events (AC8's "terminal row with the unified status
// vocabulary"); the legacy `checks[].status` field above is untouched.
export function unifiedStatusForCheck(check) {
  if (check.status === 'passed') return 'ok';
  if (check.status === 'timeout') return 'timed-out';
  // Minor fix: an aborted-in-flight check (the `cancelled: true` marker set
  // above in runNamedCheck) must report 'cancelled', not the generic
  // 'failed' every other 'unavailable' reason falls through to — the check
  // never actually failed, it was interrupted.
  if (check.cancelled) return 'cancelled';
  return 'failed';
}

// Same unified vocabulary, for the WHOLE verify run (the jsonl stream's
// terminal `result` row AND — fix-wave Important #5 — the CLI exit-code
// mapping in lib/commands.mjs#cmdVerify). Explicit run-outcome precedence,
// documented: `cancelled` wins outright (the run was interrupted, nothing
// else matters); `passed` -> ok; a hard `failed` outcome stays `failed`
// even when some OTHER check also timed out (a real failure verdict must
// never be masked by a neighboring timeout — this also aligns the code with
// this comment's own long-documented "only reason for not passing" intent);
// a run whose reason for not passing is a per-check timeout reports
// `timed-out` (AC8: "timeout per check yields timed-out distinctly" —
// carried through to the terminal row, the exit code, and command.result
// telemetry, not just the individual check); everything else (inconclusive
// for any other reason) is a generic `failed`.
export function statusForVerifyResult(result) {
  if (result.outcome === 'cancelled') return 'cancelled';
  if (result.outcome === 'passed') return 'ok';
  if (result.outcome !== 'failed' && (result.checks || []).some((check) => check.status === 'timeout')) return 'timed-out';
  return 'failed';
}

function checkStatusForEvidence(mapped, byId) {
  if (!Array.isArray(mapped) || mapped.length === 0) return 'failed';
  const statuses = mapped.map((id) => byId.get(id)?.status || 'unavailable');
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => ['unavailable', 'timeout', 'inconclusive'].includes(status))) return 'inconclusive';
  return statuses.every((status) => status === 'passed') ? 'passed' : 'inconclusive';
}

/**
 * Is this check one that can actually hold the run back? `skipped` is neutral
 * (e.g. the advisory structural check with no index) and so is `advisory` —
 * resolveOutcome excludes it, so counting it as a failure or offering it as the
 * next fix target would point the agent at the one check that can never unblock
 * the run. A check with NO severity field predates policy v2 and still counts.
 *
 * EXPORTED because it is a CONTRACT, not a local convenience (review finding):
 * the CLI's failure count and "next fix" line (commands.mjs) and the test that
 * pins this behavior must be the same predicate. A copy in the test can go on
 * passing while production drifts away from it.
 */
export function isGatingCheck(check) {
  return check.status !== 'passed' && check.status !== 'skipped' && check.severity !== 'advisory';
}

// Outcome reflects only non-advisory checks: an advisory failure is reported
// (checks + advisoryFailures in the evidence payload) but never flips the
// outcome or the exit code. A warn-severity failure degrades to inconclusive
// (exit 2 under enforce) instead of failed; `skipped` is always neutral.
function resolveOutcome(checks) {
  const gating = checks.filter((check) => check.severity !== 'advisory');
  if (gating.some((check) => check.status === 'failed' && check.severity !== 'warn')) return 'failed';
  if (gating.some((check) => check.status === 'failed' || ['unavailable', 'timeout', 'inconclusive'].includes(check.status))) {
    return 'inconclusive';
  }
  return 'passed';
}

/** The check ids the ACTIVE PLAN gates on: everything in
 * `verification.required` plus every id mapped under `verification.criteria`.
 * A policy may not downgrade any of them to advisory (policy.mjs). */
function planGatedCheckIds(plan) {
  const verification = plan?.fm?.verification;
  const ids = new Set();
  for (const name of Array.isArray(verification?.required) ? verification.required : []) {
    if (typeof name === 'string' && name) ids.add(name);
  }
  const criteria = verification?.criteria;
  if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
    for (const mapped of Object.values(criteria)) {
      for (const name of Array.isArray(mapped) ? mapped : []) {
        if (typeof name === 'string' && name) ids.add(name);
      }
    }
  }
  return ids;
}

/** Apply policy severities, refusing any advisory downgrade of a plan-gated
 * check. Returns the refusals alongside the checks so the run can report them
 * instead of silently disagreeing with the policy file. */
function applyCheckSeverities(checks, policy, planGated) {
  const refusedSeverityDowngrades = [];
  const applied = checks.map((check) => {
    const fallback = DEFAULT_CHECK_SEVERITIES[check.id] ?? 'enforce';
    const severity = checkSeverityFor(policy, check.id, fallback, planGated);
    if (severity !== 'advisory' && checkSeverityFor(policy, check.id, fallback) === 'advisory') {
      refusedSeverityDowngrades.push({ id: check.id, requested: 'advisory', effective: severity });
    }
    // `optional` is the existing ledger-rendering hook: advisory rows render
    // as warn, never error, without touching the style pipeline.
    return severity === 'advisory' ? { ...check, severity, optional: true } : { ...check, severity };
  });
  return { checks: applied, refusedSeverityDowngrades };
}

// Check messages and findings carry CURRENT-SIDE REPO TEXT (structural/
// expectations.mjs derives its symbol names from a lexical extractor whose
// per-language patterns are not length-bounded — a `.tf` string literal
// spanning newlines can produce a six-figure-byte "symbol name" — and echoes
// plan-declared expectations back verbatim), and the CANONICAL `result.checks`
// array is what `.harness/evidence/*.json`, `verify --json`, and the event log
// all serialize. Sanitizing only the advisory summary copy left every one of
// those surfaces shipping the raw text. Every other surface that renders
// less-trusted repo-derived text redacts it, flattens control characters, and
// caps it; the shipped check payload must do the same, at the one boundary
// (finalize) every consumer reads from.
const CHECK_TEXT_CAP = 240;
const CHECK_LIST_CAP = 20;
const CHECK_FINDINGS_CAP = 50;
const CHECK_DEPTH_CAP = 3;

// The free-text LIST payloads a check can carry (`message` is handled on its
// own below). `id`/`status`/`severity`/`optional`/`exitCode`/`durationMs` are
// code-set tokens, enums, or numbers — never credential carriers — and
// `stdout`/`stderr` are the trusted named command's own output, already
// length-bounded by trimOutput and deliberately left multi-line so a failing
// check stays readable.
// `details` (plan-schema / plan-readiness sub-check messages) and `openTasks`
// (verbatim `- [ ]` lines lifted out of the plan body) are PLAN-DERIVED text on
// exactly the same surfaces — `.harness/evidence/*.json`, `verify --json`, the
// event log — and a plan is an ordinary repo file a human or model writes. They
// were the two list payloads shipping unredacted, unflattened, and unbounded.
const SANITIZED_CHECK_LISTS = ['findings', 'informational', 'details', 'openTasks'];

function checkText(value) {
  return inertLine(redactSecrets(String(value ?? ''))).slice(0, CHECK_TEXT_CAP);
}

/** Redact + flatten + cap every string reachable in a finding, bound every
 * array/object to CHECK_LIST_CAP entries, and stop at CHECK_DEPTH_CAP —
 * shape-agnostic, so a check that grows a new findings field is covered
 * without this function knowing about it. */
function checkValue(value, depth = 0) {
  if (typeof value === 'string') return checkText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= CHECK_DEPTH_CAP) return null;
  if (Array.isArray(value)) return value.slice(0, CHECK_LIST_CAP).map((entry) => checkValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, CHECK_LIST_CAP)) {
      out[checkText(key)] = checkValue(entry, depth + 1);
    }
    return out;
  }
  return null;
}

/** Sanitize one check's shipped payload. Idempotent: applied at finalize and
 * again (harmlessly) by collectAdvisoryFailures on the same objects. */
export function sanitizeCheckPayload(check) {
  const sanitized = { ...check };
  if (check.message !== undefined) sanitized.message = checkText(check.message);
  for (const field of SANITIZED_CHECK_LISTS) {
    if (check[field] === undefined) continue;
    sanitized[field] = (Array.isArray(check[field]) ? check[field] : []).slice(0, CHECK_FINDINGS_CAP).map((entry) => checkValue(entry));
  }
  return sanitized;
}

export function collectAdvisoryFailures(checks) {
  return checks
    .filter((check) => check.severity === 'advisory' && !['passed', 'skipped'].includes(check.status))
    .map((check) => ({
      id: check.id,
      status: check.status,
      message: checkText(check.message),
      ...(check.findings
        ? { findings: (Array.isArray(check.findings) ? check.findings : []).slice(0, CHECK_FINDINGS_CAP).map((f) => checkValue(f)) }
        : {}),
    }));
}

function currentPhaseTasks(taskBody, phase) {
  const current = Number(phase);
  if (!Number.isInteger(current)) return taskBody;
  const heading = new RegExp(`^###\\s+Phase\\s+${current}\\b[^\\n]*\\n`, 'im');
  const match = heading.exec(taskBody);
  if (!match) return taskBody;
  const bodyStart = match.index + match[0].length;
  const remaining = taskBody.slice(bodyStart);
  const nextHeading = remaining.search(/^###\s+Phase\s+\d+\b/im);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

// `skipEvidence` (AC8): a cancelled run must never write evidence — the
// checks array is a partial, interrupted snapshot, not something a later
// `compound`/completion gate should ever bind to. Every other caller keeps
// writing evidence exactly as before.
function finalize(workspace, flags, partial, { skipEvidence = false } = {}) {
  const policy = loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome) });
  const severities = applyCheckSeverities(partial.checks, policy, partial.planGatedChecks || new Set());
  // The single boundary every consumer reads from: evidence, `--json`, the
  // event log, and the ledger all serialize this array.
  const checks = severities.checks.map(sanitizeCheckPayload);
  const result = {
    outcome: partial.outcome || resolveOutcome(checks),
    plan: partial.plan || null,
    checks,
    advisoryFailures: collectAdvisoryFailures(checks),
    refusedSeverityDowngrades: severities.refusedSeverityDowngrades,
    unverifiedCriteria: partial.unverifiedCriteria || [],
    scopeViolations: partial.scopeViolations || [],
    openHardGaps: partial.openHardGaps || [],
    requiredReviews: partial.requiredReviews || [],
    enforcement: policy.enforcement,
    // P3AC6: a run whose enforcement mode came from the built-in default
    // because an unapproved project's policy.yaml was skipped must say so.
    // Otherwise the operator sees `enforce` where their file says `warn` and
    // has nothing to connect it to.
    projectPolicyIgnored: policy.projectPolicyIgnored,
    exemptions: policy.exemptions,
    waivers: policy.waivers,
    binding: partial.binding || null,
    evidencePath: null,
  };
  result.evidencePath = skipEvidence ? null : writeEvidence(workspace, result, flags.dryRun);
  return result;
}

// P1.6 (AC8): async now that named checks run through lib/runner.mjs.
// `signal` (an AbortSignal, optional) cancels a check in flight; `onEvent`
// (optional `(event, fields) => void`) is the streaming hook `verify
// --output jsonl` wires to lib/envelope.mjs's createJsonlStream — see
// lib/commands.mjs's cmdVerify. Neither parameter changes behavior for any
// caller that omits them (doctor.mjs's fixture probe, every existing test).
export async function runVerify({ workspace, flags, signal, onEvent }) {
  const session = readSession(workspace);
  const selected = selectPlan(workspace, {
    planPath: flags.plan,
    session,
    requireUnique: true,
  });
  if (!selected.plan) {
    return finalize(workspace, flags, {
      outcome: 'inconclusive',
      checks: [resultCheck('plan-selection', 'inconclusive', selected.error || 'No locked active plan; pass --plan explicitly')],
    });
  }

  const plan = selected.plan;
  const checks = [];
  const schema = validatePlanSchema(plan);
  checks.push(
    resultCheck(
      'plan-schema',
      schema.pass ? 'passed' : 'failed',
      schema.pass ? `Plan schema v${schema.version} valid` : schema.checks.filter((check) => !check.pass).map((check) => check.message).join('; '),
      { details: schema.checks }
    )
  );

  const readiness = validatePlanReadiness(workspace, plan);
  checks.push(
    resultCheck(
      'plan-readiness',
      readiness.pass ? 'passed' : 'failed',
      readiness.pass
        ? 'Plan verification contract is ready'
        : readiness.checks.filter((check) => !check.pass).map((check) => check.message).join('; '),
      { details: readiness.checks }
    )
  );

  const statePass = plan.plan_lock && ['in-progress', 'review', 'done'].includes(plan.status);
  checks.push(resultCheck('plan-state', statePass ? 'passed' : 'failed', statePass ? 'Plan is locked in a verifiable state' : `Invalid verify state: ${plan.status}, plan_lock=${plan.plan_lock}`));

  const taskBody = currentPhaseTasks(plan.sections.plan || '', plan.phase);
  const openTasks = [...taskBody.matchAll(/^-\s*\[ \]\s+(.+)$/gm)].map((match) => match[1]);
  checks.push(resultCheck('phase-tasks', openTasks.length ? 'failed' : 'passed', openTasks.length ? `${openTasks.length} current phase tasks remain open` : 'All current phase tasks are complete', { openTasks }));

  // Bind-before-check snapshot: the workspace digest captured here must match
  // the digest captured after checks run, or the evidence would certify
  // content the checks never saw.
  const preScope = validatePlanScope({ workspace, plan, base: flags.base });
  const preBinding = createEvidenceBinding({
    workspace,
    plan,
    base: flags.base,
    changedFiles: preScope.changedFiles,
  });

  const named = loadNamedChecks(workspace);
  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
  // Fix-wave Important #9 (AC8): one redactor for the whole streaming run,
  // one streamer per check — live output rows flow through onEvent between
  // the check's progress marker and its status row.
  const streamRedactor = onEvent ? createRedactor() : null;
  // Sequential (not Promise.all): a later check must never start once
  // cancellation has been observed, and streaming rows must land in the same
  // order checks actually ran in.
  const namedResults = [];
  for (const name of required) {
    if (!readiness.pass) {
      namedResults.push(resultCheck(name, 'inconclusive', 'Not run because plan readiness failed'));
      continue;
    }
    if (named.error) {
      namedResults.push(resultCheck(name, 'unavailable', named.error));
      continue;
    }
    if (!Object.hasOwn(named.checks, name)) {
      namedResults.push(resultCheck(name, 'unavailable', `Named check is not configured: ${name}`));
      continue;
    }
    onEvent?.('progress', { check: name, phase: 'start' });
    const streamer = onEvent
      ? createCheckOutputStreamer({ check: name, onEvent, redactText: streamRedactor.redactText })
      : null;
    const outcome = await runNamedCheck(workspace, name, named.checks[name], {
      signal,
      onStdout: streamer?.onStdout,
      onStderr: streamer?.onStderr,
    });
    streamer?.flush();
    onEvent?.('row', { check: name, status: outcome.status, unifiedStatus: unifiedStatusForCheck(outcome), message: outcome.message });
    namedResults.push(outcome);
    if (signal?.aborted) break; // stop running further checks once cancelled
  }
  checks.push(...namedResults);

  // AC8: cancellation short-circuits the whole run — no further checks
  // (scope, criteria-evidence, workspace-stability, …) run against a
  // partial/interrupted snapshot, and evidence is never written for it.
  if (signal?.aborted) {
    return finalize(
      workspace,
      flags,
      {
        outcome: 'cancelled',
        plan: plan.path,
        checks,
      },
      { skipEvidence: true }
    );
  }

  const byId = new Map(namedResults.map((check) => [check.id, check]));
  const criterionIds = extractAcceptanceCriteria(plan);
  const criterionMappings = plan.fm.verification?.criteria || {};
  const unverifiedCriteria = [];
  const criterionStatuses = criterionIds.map((id) => {
    const status = checkStatusForEvidence(criterionMappings[id], byId);
    if (status !== 'passed') unverifiedCriteria.push(id);
    return { id, status };
  });
  let criteriaStatus = 'passed';
  if (criterionStatuses.some((entry) => entry.status === 'failed')) criteriaStatus = 'failed';
  else if (criterionStatuses.some((entry) => entry.status === 'inconclusive')) criteriaStatus = 'inconclusive';
  checks.push(resultCheck('criteria-evidence', criteriaStatus, unverifiedCriteria.length ? `Unverified criteria: ${unverifiedCriteria.join(', ')}` : 'Every acceptance criterion has passed named evidence', { criteria: criterionStatuses }));

  const scope = validatePlanScope({ workspace, plan, base: flags.base });
  checks.push(resultCheck('scope', scope.status, scope.message, { changedFiles: scope.changedFiles, allowed: scope.allowed }));

  // Advisory structural diff vs plan (severity from policy; skips without an
  // index or a current baseline — see lib/structural/expectations.mjs).
  if (scope.status === 'inconclusive') {
    checks.push(resultCheck(STRUCTURAL_CHECK_ID, 'skipped', 'Advisory structural check skipped: changed files unavailable'));
  } else {
    const structural = runStructuralExpectations({ workspace, plan, changedFiles: scope.changedFiles });
    checks.push(
      resultCheck(STRUCTURAL_CHECK_ID, structural.status, structural.message, {
        findings: structural.findings,
        informational: structural.informational,
        baseline: structural.baseline,
      })
    );
  }

  const primitive = verifyPrimitiveGovernance(plan, scope.changedFiles, Object.keys(named.checks || {}));
  if (primitive.required) {
    checks.push(
      resultCheck(
        'primitive-evidence',
        primitive.pass ? 'passed' : 'failed',
        primitive.message,
        {
          changedPrimitives: primitive.changedPrimitives,
          missingPlan: primitive.missingPlan,
          missingEvidence: primitive.missingEvidence,
        }
      )
    );
  }

  const requiredReviews = (plan.fm.reviews?.required || []).filter((review) => !(plan.fm.reviews?.completed || []).includes(review));
  checks.push(resultCheck('required-reviews', requiredReviews.length ? 'failed' : 'passed', requiredReviews.length ? `Missing required reviews: ${requiredReviews.join(', ')}` : 'Required reviews satisfied'));

  const openHardGaps = (plan.fm.capability_gaps || []).filter(
    (gap) => gap && typeof gap === 'object' && gap.class === 'hard' && !['done', 'bridge', 'waived'].includes(gap.fulfillment)
  );
  checks.push(resultCheck('hard-gaps', openHardGaps.length ? 'failed' : 'passed', openHardGaps.length ? `${openHardGaps.length} hard capability gaps remain open` : 'No open hard capability gaps'));

  const criticalOpen = plan.fm.reviews?.critical_open || [];
  checks.push(resultCheck('critical-findings', criticalOpen.length ? 'failed' : 'passed', criticalOpen.length ? `${criticalOpen.length} critical findings remain open` : 'No open critical review findings'));

  const binding = createEvidenceBinding({
    workspace,
    plan,
    base: flags.base,
    changedFiles: scope.changedFiles,
  });
  const stable =
    preBinding.workspaceDigest === binding.workspaceDigest && preBinding.planDigest === binding.planDigest;
  checks.push(
    resultCheck(
      'workspace-stability',
      stable ? 'passed' : 'failed',
      stable
        ? 'Workspace did not change while checks ran'
        : 'Workspace or plan changed while verification checks were running; rerun harness verify'
    )
  );

  return finalize(workspace, flags, {
    plan: plan.path,
    checks,
    planGatedChecks: planGatedCheckIds(plan),
    unverifiedCriteria,
    scopeViolations: scope.violations,
    openHardGaps,
    requiredReviews,
    binding,
  });
}

export function exitCodeForOutcome(outcome, enforcement = 'enforce') {
  return enforcementExitCode(outcome, enforcement);
}
