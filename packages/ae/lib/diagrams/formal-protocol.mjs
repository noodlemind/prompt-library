// This reads retained TLC protocol data. It neither evaluates TLA+ nor runs a checker.
export const formalFailure = message => Object.assign(new Error(`formal trace: ${message}`), { code: 'E_DIAGRAM', exit: 2 });
const bytes = text => new TextEncoder().encode(text).length;
const STATE = new Set([2107, 2217, 2218, 2122]);

export function readTlcRun(stdout) {
  if (typeof stdout !== 'string' || !stdout || bytes(stdout) > 512 * 1024 || stdout.includes('\0')) throw formalFailure('recorded TLC stdout is missing or exceeds 512 KiB');
  const frames = [], open = [];
  let count = 0;
  for (const line of stdout.replaceAll('\r\n', '\n').split('\n')) {
    const start = /@!@!@STARTMSG (\d{1,5}):([0-4]) @!@!@$/.exec(line);
    const end = /^@!@!@ENDMSG (\d{1,5}) @!@!@$/.exec(line);
    if (start) {
      if (++count > 4096 || open.length >= 16) throw formalFailure('recorded TLC frames exceed their bound');
      const next = { code: +start[1], level: +start[2], lines: [], children: [] };
      if (open.length) open.at(-1).children.push(next);
      open.push(next);
    } else if (end) {
      const frame = open.pop();
      if (!frame || frame.code !== +end[1]) throw formalFailure('recorded TLC frames are malformed');
      if (!open.length) frames.push(frame);
    } else {
      if (/^@!@!@(?:STARTMSG|ENDMSG)/.test(line)) throw formalFailure('recorded TLC frame marker is malformed');
      if (open.length) open.at(-1).lines.push(line);
    }
  }
  if (open.length || !count) throw formalFailure('recorded TLC frames are incomplete');
  if (frames.filter(frame => frame.code === 2186).length !== 1 || frames.at(-1)?.code !== 2186) throw formalFailure('TLC did not record exactly one completed run');
  const errors = [];
  const inspect = (list, nested = false) => {
    for (const frame of list) {
      if (frame.level === 4 && !STATE.has(frame.code) || [2217, 2218, 2122].includes(frame.code) && frame.level !== 4) throw formalFailure('recorded TLC has an unsupported or incorrectly classified state frame');
      if (nested && (STATE.has(frame.code) || [2110, 2116].includes(frame.code))) throw formalFailure('nested checker error or state frames cannot be replayed without losing evidence');
      if (frame.level === 1 || frame.level === 2) errors.push(frame);
      inspect(frame.children, true);
    }
  };
  inspect(frames);
  const broken = frames.filter(frame => [2107, 2110, 2116].includes(frame.code));
  let violation = null;
  if (broken.length === 1) {
    const frame = broken[0];
    if (frame.code === 2116) violation = { kind: 'temporal', property: null };
    else {
      const name = /^Invariant ([A-Za-z][A-Za-z0-9_]*) is violated(?:\.| by the initial state:)/.exec(frame.lines.join('\n'))?.[1];
      if (name) violation = { kind: 'invariant', property: name };
    }
  }
  const statsFrame = frames.find(frame => frame.code === 2199);
  const stats = /(\d[\d,]*) states generated, (\d[\d,]*) distinct states found, (\d[\d,]*) states left on queue/.exec(statsFrame?.lines.join('\n') || '');
  const numbers = stats?.slice(1).map(value => Number(value.replaceAll(',', '')));
  if (numbers?.some(value => !Number.isSafeInteger(value))) throw formalFailure('recorded exploration counts exceed their exact range');
  return { frames, errors, violation, violationCount: broken.length,
    states: numbers ? { generated: numbers[0], distinct: numbers[1], remaining: numbers[2] } : null,
    success: frames.some(frame => frame.code === 2193) };
}

function valueScanner() {
  const stack = [];
  let quoted = false;
  return {
    get complete() { return !quoted && !stack.length; },
    append(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i], pair = text.slice(i, i + 2);
        if (quoted) {
          if (ch === '\\') i += 1;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') quoted = true;
        else if (pair === '<<') { stack.push('>>'); i += 1; }
        else if (pair === '>>') {
          if (stack.pop() !== '>>') throw formalFailure('recorded state has malformed value delimiters');
          i += 1;
        } else if ('[{('.includes(ch)) stack.push({ '[': ']', '{': '}', '(': ')' }[ch]);
        else if (']})'.includes(ch) && stack.pop() !== ch) throw formalFailure('recorded state has malformed value delimiters');
        if (stack.length > 64) throw formalFailure('recorded state value nesting exceeds its bound');
      }
      if (quoted) throw formalFailure('recorded state has an unterminated string');
    },
  };
}

/** Values are opaque TLC text: integers, sets and functions are never coerced. */
export function readTlcState(text) {
  if (typeof text !== 'string' || !text.trim() || /«redacted(?::|»)|\[REDACTED\]/i.test(text)) throw formalFailure('recorded state is missing or damaged by redaction');
  const body = text.replaceAll('\r\n', '\n').trim();
  if (/\n\s*\n/.test(body)) throw formalFailure('recorded state contains content after a blank line');
  const variables = [], names = new Set();
  let current = null, scanner;
  const finish = () => {
    const valueText = current?.lines.join('\n').trim();
    if (!valueText || !scanner.complete) throw formalFailure('recorded state has an incomplete value');
    variables.push({ name: current.name, valueText });
  };
  for (const line of body.split('\n')) {
    const assignment = /^(?:\/\\\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const separated = line.startsWith('/\\ ');
    const complete = scanner?.complete;
    if (!current || separated && complete) {
      if (!assignment) throw formalFailure('recorded state has malformed variables');
      if (current) finish();
      if (names.has(assignment[1])) throw formalFailure('recorded state has duplicate variables');
      names.add(assignment[1]);
      current = { name: assignment[1], lines: [assignment[2]] };
      scanner = valueScanner(); scanner.append(assignment[2]);
    } else {
      if (complete) throw formalFailure('recorded state has trailing content without a variable boundary');
      current.lines.push(line); scanner.append(line);
    }
  }
  finish();
  return variables;
}

export function readTlcTrace(run) {
  const nodes = [], edges = [];
  let loop = null, stutters = false, names;
  const add = (frame, action, body) => {
    if (loop !== null) throw formalFailure('recorded state sequence continues after its loop');
    const variables = readTlcState(body);
    const key = variables.map(value => value.name).sort().join(',');
    if (names !== undefined && names !== key) throw formalFailure('recorded states have inconsistent variable sets');
    names = key;
    const id = `s${nodes.length}`;
    if (nodes.length) edges.push({ from: `s${nodes.length - 1}`, to: id, action, role: 'transition' });
    nodes.push({ id, initial: nodes.length === 0, variables });
  };
  for (const frame of run.frames) {
    const text = frame.lines.join('\n').trim();
    if (frame.code === 2217) {
      const header = /^(\d+): <([^<>]+)>$/.exec(frame.lines[0] || '');
      if (!header || +header[1] !== nodes.length + 1) throw formalFailure('recorded state sequence is malformed or out of order');
      add(frame, header[2], frame.lines.slice(1).join('\n'));
    } else if (frame.code === 2107) add(frame, '', frame.lines.slice(1).join('\n'));
    else if (frame.code === 2122) {
      const back = /^(\d+): Back to state: <([^<>]+)>$/.exec(text);
      if (loop !== null || !back || +back[1] < 1 || +back[1] > nodes.length) throw formalFailure('recorded temporal loop target is invalid');
      loop = +back[1] - 1;
      edges.push({ from: `s${nodes.length - 1}`, to: `s${loop}`, action: back[2], role: 'loop' });
    } else if (frame.code === 2218) {
      if (loop !== null || !nodes.length || !new RegExp(`^${nodes.length + 1}: Stuttering$`).test(text)) throw formalFailure('recorded stuttering frame is malformed');
      loop = nodes.length - 1; stutters = true;
      edges.push({ from: `s${loop}`, to: `s${loop}`, action: 'stutters forever', role: 'stutter' });
    }
  }
  if (!nodes.length) throw formalFailure('recorded counterexample has no readable states');
  if (run.violation?.kind === 'temporal' && loop === null) throw formalFailure('recorded temporal counterexample is missing its loop or stuttering witness');
  if (run.violation?.kind !== 'temporal' && loop !== null) throw formalFailure('a safety counterexample cannot contain a temporal loop');
  return { nodes, edges, loop, stutters };
}
