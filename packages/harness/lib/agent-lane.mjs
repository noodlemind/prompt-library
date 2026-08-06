/**
 * Agent lane — the "LLM" audience from docs/architecture/harness-cli-workbench.md
 * § "Output lanes: the three-audience contract". Budgeted plain text,
 * rendered deterministically from a command's canonical result (or its
 * envelope — both are plain data objects, so either works as input); never a
 * model pass, never a summary of the JSON envelope.
 *
 * Agent-lane requirements (architecture doc, binding):
 *   1. Budgeted at the source — a hard local byte cap, truncated at item
 *      boundaries, the reported size never exceeding the budget.
 *   2. Deterministic — same input, same bytes, always.
 *   3. Hardened — retrieved/free-text content passes through the existing
 *      data-boundary idioms: secret redaction (lib/redact.mjs's
 *      `createRedactor`) and control-character neutralization
 *      (lib/knowledge/store.mjs's `inertLine`). This module composes those,
 *      it does not reimplement either.
 *   4. Metered — the rendered byte count is returned so a caller can log it
 *      against `harness report`'s token/utilization SLOs.
 *
 * Rendering is intentionally generic (not per-command): every top-level
 * scalar becomes one `key value` line (the one-line-footer material); every
 * top-level array/object becomes one line PER ITEM — an array element or a
 * nested object's own key — so the budget can truncate whole items without
 * ever slicing inside one. No markdown tables, no JSON dumps.
 */
import { createRedactor } from './redact.mjs';
import { inertLine } from './knowledge/store.mjs';
import { splitScalarsAndDetails } from './envelope.mjs';

// Same precedent this codebase already sets in three other places (the 2 KB
// context pack, the bounded `harness get` excerpt, the repo map budget) —
// see lib/context-pack.mjs's CONTEXT_PACK_MAX_BYTES. A registry entry may
// override this per command via `agentBudgetBytes`.
export const DEFAULT_AGENT_BUDGET_BYTES = 2048;

const TRUNCATION_MARKER = '… (truncated to agent-lane budget)';

function formatScalar(value, inert) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return inert(value);
  return String(value);
}

// A one-line, lossy-but-bounded rendering of an array element or a nested
// object's value — used where a full recursive dump would risk an unbounded
// line. Depth is deliberately shallow (one level of `k=v`): the agent lane's
// job is a budgeted SUMMARY, not a lossless re-serialization of the result.
function formatCompact(value, inert) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return formatScalar(value, inert);
  if (Array.isArray(value)) {
    return value.length ? `[${value.length} items]` : '[]';
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return entries.map(([k, v]) => `${k}=${isScalarLeaf(v) ? formatScalar(v, inert) : compactPlaceholder(v)}`).join(' · ');
}

function isScalarLeaf(value) {
  return value === null || value === undefined || typeof value !== 'object';
}

function compactPlaceholder(value) {
  if (Array.isArray(value)) return value.length ? `[${value.length} items]` : '[]';
  const n = Object.keys(value).length;
  return n ? `{${n} keys}` : '{}';
}

/**
 * Flatten one canonical result (or envelope) into an ordered list of
 * self-contained "item" lines — scalars first, then one item per array
 * element / nested-object key, matching `splitScalarsAndDetails`'s
 * scalars-first/details-after rule so the agent lane and the envelope lane
 * agree on what "summary" vs "detail" means for the same data.
 */
function buildItems(data, inert) {
  const { scalars, details } = splitScalarsAndDetails(data);
  const items = [];

  for (const [key, value] of Object.entries(scalars)) {
    items.push(`${key} ${formatScalar(value, inert)}`);
  }

  // `splitScalarsAndDetails` already routes `null` into `scalars`, so every
  // `details` value here is an array or a non-null object — never null.
  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value)) {
      if (!value.length) {
        items.push(`${key} (0 items)`);
        continue;
      }
      value.forEach((el, i) => items.push(`${key}[${i}] ${formatCompact(el, inert)}`));
      continue;
    }
    // Plain object: one item per own key, so a large nested object still
    // truncates at a meaningful (per-field) boundary rather than all-or-nothing.
    const entries = Object.entries(value);
    if (!entries.length) {
      items.push(`${key} {}`);
      continue;
    }
    for (const [k, v] of entries) {
      items.push(`${key}.${k} ${formatCompact(v, inert)}`);
    }
  }

  return items;
}

/**
 * Pack ordered `items` (each already one self-contained line, no embedded
 * newline) into `budgetBytes`, dropping whole trailing items — never a
 * partial one — once the budget would be exceeded. Guarantees
 * `bytes <= budgetBytes` for every input, including a budget too small to
 * hold even the truncation marker (degrades to an empty string rather than
 * ever exceeding the cap).
 */
function packItems(items, budgetBytes) {
  const budget = Math.max(0, Math.floor(Number(budgetBytes) || 0));
  const kept = [];

  for (const item of items) {
    const candidateText = [...kept, item].join('\n');
    if (Buffer.byteLength(candidateText, 'utf8') <= budget) {
      kept.push(item);
    } else {
      break; // item boundary: never slice this (or any later) item
    }
  }

  const truncated = kept.length < items.length;
  if (!truncated) {
    const text = kept.join('\n');
    return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false };
  }

  // Truncated: try to append the marker; if it doesn't fit alongside every
  // currently kept item, drop kept items from the tail (item boundary again)
  // until it does, or until nothing is left — the hard cap is never violated
  // either way, even when the budget is smaller than the marker itself.
  for (;;) {
    const candidate = kept.length ? `${kept.join('\n')}\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER;
    const bytes = Buffer.byteLength(candidate, 'utf8');
    if (bytes <= budget) return { text: candidate, bytes, truncated: true };
    if (!kept.length) return { text: '', bytes: 0, truncated: true };
    kept.pop();
  }
}

/**
 * Render one canonical result (or envelope) as budgeted, hardened plain
 * text for the agent lane.
 *
 * @param {object} result - the command's canonical result data (or its
 *   envelope — a plain, JSON-shaped object either way).
 * @param {object} [opts]
 * @param {number} [opts.budgetBytes] - hard byte cap; defaults to
 *   `DEFAULT_AGENT_BUDGET_BYTES`. A registry entry's `agentBudgetBytes`
 *   flows in here from the caller.
 * @param {{redactText: Function, redactValue: Function}} [opts.redactor] -
 *   defaults to `createRedactor()` (secure by default) — inject a fake to
 *   assert it ran, or a differently-configured real one (e.g. a fixed env)
 *   for reproducible tests.
 * @param {(text: string) => string} [opts.inert] - control-character
 *   neutralizer for every string leaf that reaches the rendered text;
 *   defaults to `inertLine` (secure by default), injectable for tests.
 * @returns {{text: string, bytes: number, truncated: boolean}}
 */
export function renderAgentLane(result, { budgetBytes = DEFAULT_AGENT_BUDGET_BYTES, redactor, inert = inertLine } = {}) {
  const activeRedactor = redactor || createRedactor();
  // Redact BEFORE flattening, once, over the whole structure — reuses
  // redact.mjs's own deep walk rather than reimplementing one here.
  const safe = activeRedactor.redactValue(result ?? {});
  const items = buildItems(safe, inert);
  return packItems(items, budgetBytes);
}

/**
 * Metering stub (requirement #4 — "metered"). Pure with respect to module
 * state: takes the events sink as a parameter instead of importing
 * lib/events.mjs directly, so this file has zero coupling to it — wiring the
 * real sink through `harness report`'s SLOs is Task 5's job. `eventsApi`,
 * when given, must expose a `writeEvent(payload)` method (the existing
 * lib/events.mjs shape); when omitted, this only computes and returns the
 * record.
 */
export function recordAgentLaneBytes(eventsApi, command, bytes) {
  const record = { type: 'agent_lane', command, bytes };
  if (eventsApi && typeof eventsApi.writeEvent === 'function') {
    eventsApi.writeEvent(record);
  }
  return record;
}
