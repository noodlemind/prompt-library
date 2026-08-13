/** First-run / replay Adaptive Engineer story. Session chrome, not a kernel command. */

export const WALKTHROUGH_SEEN_KEY = 'walkthrough.seen';

export const WALKTHROUGH_BEATS = Object.freeze([
  {
    title: 'Adaptive Engineer Harness',
    footer: 'Enter next · Esc skip',
    body: Object.freeze([
      'This is the evidence-governed kernel behind @engineer. The model may be stochastic. Delivery is not: intent is locked, mutation is gated, "done" requires fresh proof, and only proven work is allowed to become team memory.',
    ]),
  },
  {
    title: 'The loop that compounds',
    footer: 'Enter next · Esc skip',
    body: Object.freeze([
      'Each Deliver pass runs the same contract:',
      '',
      'orient → lock intent → gate → work → verify → compound → index',
      '',
      'You watch it on this ledger. Plan and gate are the live chips in the header. Orient, verify, and compound run in the kernel — they are not chores you type here. The next task can recall only what this one proved. That is what makes the engineer adaptive.',
    ]),
  },
  {
    title: 'Almost none of this is yours to run',
    footer: 'Enter start · Esc close',
    body: Object.freeze([
      'In VS Code or GitHub Copilot Chat, open the agent dropdown and pick @engineer. Answer, Investigate, and Review stay read-only. Deliver is the only mode that mutates. Behind the scenes the kernel orients, gates, verifies, and auto-compounds after a green verify.',
      '',
      'You only touch this UI when:',
      '',
      'First install — reload VS Code so the Copilot bridge loads.',
      'New product repo — palette Initialize this repo if there is no plan/checks scaffolding.',
      'After a win — ask @engineer to compound if you want a deliberate write-up, or auto-compound did not fire.',
      'As HEAD grows — run Index (palette) or harness index when knowledge is behind the current commit.',
    ]),
  },
]);

const INSTALL_LINE = 'Copilot assets and the editor bridge were installed.';

function lastBeatIndex() {
  return WALKTHROUGH_BEATS.length - 1;
}

export function createWalkthrough({ hydrated = false } = {}) {
  let beat = 0;
  return {
    kind: 'walkthrough',
    hydrated: Boolean(hydrated),
    get beat() { return beat; },
    handleKey(str, key = {}) {
      const name = key.name;
      const ctrl = Boolean(key.ctrl);
      if (name === 'escape' || (ctrl && name === 'c')) {
        return { intent: 'dismiss', changed: true };
      }
      if (name === 'left' || name === 'up') {
        if (beat === 0) return { intent: null, changed: false };
        beat -= 1;
        return { intent: 'prev', changed: true };
      }
      const advance = name === 'right' || name === 'down'
        || name === 'return' || name === 'enter'
        || name === 'space' || str === ' ';
      if (!advance) return { intent: null, changed: false };
      if (name === 'right' || name === 'down') {
        if (beat >= lastBeatIndex()) return { intent: null, changed: false };
        beat += 1;
        return { intent: 'next', changed: true };
      }
      if (beat >= lastBeatIndex()) return { intent: 'complete', changed: true };
      beat += 1;
      return { intent: 'next', changed: true };
    },
  };
}

export function attachWalkthroughOverlay(wt, { onClose } = {}) {
  return {
    kind: 'walkthrough',
    get beat() { return wt.beat; },
    get hydrated() { return wt.hydrated; },
    handleKey(str, key) {
      const result = wt.handleKey(str, key);
      if (result.intent === 'dismiss' || result.intent === 'complete') {
        try { onClose?.(result.intent); } catch { /* persist must not crash the session */ }
        return { intent: 'close', changed: true };
      }
      return { intent: null, changed: Boolean(result.changed) };
    },
  };
}

export function walkthroughLines({ hydrated = false } = {}) {
  const lines = [];
  for (const [i, spec] of WALKTHROUGH_BEATS.entries()) {
    if (i > 0) lines.push('');
    lines.push(spec.title);
    for (const paragraph of spec.body) lines.push(paragraph);
    if (i === 0 && hydrated) lines.push(INSTALL_LINE);
  }
  return lines;
}

export function renderWalkthrough(wt, { ui, width = 80 } = {}) {
  const spec = WALKTHROUGH_BEATS[wt.beat] || WALKTHROUGH_BEATS[0];
  const paint = ui?.paint ? (token, text) => ui.paint(token, text) : (_t, text) => text;
  const max = Math.max(24, Number(width) || 80);
  const wrap = (text) => wrapLine(String(text ?? ''), max);
  const out = ['', paint('info', spec.title), ''];
  for (const paragraph of spec.body) {
    if (!paragraph) { out.push(''); continue; }
    out.push(...wrap(paragraph).map((line) => paint('muted', line)));
  }
  if (wt.hydrated && wt.beat === 0) {
    out.push('');
    out.push(paint('muted', INSTALL_LINE));
  }
  out.push('');
  out.push(paint('muted', spec.footer));
  return out;
}

export function shouldAutoOpenWalkthrough({ interactive = false, screenReader = false, seen = false } = {}) {
  if (seen) return null;
  if (screenReader) return 'lines';
  if (interactive) return 'overlay';
  return null;
}

function wrapLine(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}
