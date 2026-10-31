const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

function pathLike(token) {
  return Boolean(token) && !/\s/.test(token) && (token.includes('/') || token.includes('.') || token.endsWith('/**'));
}

function normalizeImpacted(entry) {
  return String(entry || '').replace(/^\.\//, '').replace(/\\/g, '/').trim();
}

function splitPiece(piece) {
  let text = String(piece || '').replace(/\s+#.*$/, '').trim();
  text = text.replace(/\s+[—–]\s+.*$/, '').replace(/\s+-\s+.*$/, '').trim();
  if (!text) return [];
  const comma = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (comma.length > 1 && comma.every(pathLike)) return comma;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(pathLike)) return words;
  if (words.length > 1 && pathLike(words[0]) && !words.slice(1).every(pathLike)) return [words[0]];
  return [text];
}

/** One impacted path per file, for every list shape the plan instructions allow. */
export function parseImpactedText(section) {
  const found = [];
  for (const raw of String(section || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const marked = line.match(LIST_MARK);
    const body = marked ? marked[1] : line;
    const ticked = [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
    // One backtick pair is one path, including spaces and commas. Unquoted lists still split.
    const pieces = ticked.length
      ? ticked
      : (marked || body.includes(','))
        ? splitPiece(body)
        : [];
    for (const piece of pieces) {
      const entry = normalizeImpacted(piece);
      if (entry) found.push(entry);
    }
  }
  return [...new Set(found)];
}
