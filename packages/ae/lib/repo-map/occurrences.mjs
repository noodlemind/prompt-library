const blank = value => /[\r\n]/.test(value) ? value.replace(/[^\r\n]/g, ' ') : ' '.repeat(value.length);

/** Offset-preserving lexical masks. This is a conservative fallback, not a parser. */
export function sourceMasks(rel, text) {
  const python = /\.py$/i.test(rel);
  const sql = /\.sql$/i.test(rel);
  const javascript = /\.[cm]?[jt]sx?$/i.test(rel);
  const marker = python ? /["']|#/g : /["'`]|\/\/|\/\*|\/|--/g;
  const clean = [], code = [];
  let distinctCodeMask = false;
  let at = 0, match;
  while ((match = marker.exec(text))) {
    const start = match.index, token = match[0];
    let end, comment = token === '#' || token === '//' || token === '/*' || (sql && token === '--');
    if (token === '--' && !sql) continue;
    if (token === '/') {
      const prefix = text.slice(Math.max(0, start - 32), start).trimEnd();
      if (!javascript || !/(?:^|[=(:,!&|?{};\[]|\b(?:return|throw|yield|case))$/.test(prefix)) continue;
      end = start + 1;
      let characterClass = false;
      while (end < text.length && text[end] !== '\n') {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '[') characterClass = true;
        else if (text[end] === ']') characterClass = false;
        else if (text[end] === '/' && !characterClass) { end++; break; }
        end++;
      }
    } else if (comment) {
      end = token === '/*' ? text.indexOf('*/', start + 2) : text.indexOf('\n', start + token.length);
      end = end < 0 ? text.length : token === '/*' ? end + 2 : end;
    } else {
      const delimiter = text.startsWith(token.repeat(3), start) && (python || /\.java$/i.test(rel)) ? token.repeat(3) : token;
      end = start + delimiter.length;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text.startsWith(delimiter, end)) { end += delimiter.length; break; }
        end++;
      }
      end = Math.min(end, text.length);
    }
    const prefix = text.slice(at, start), hidden = blank(text.slice(start, end));
    if (!comment && !distinctCodeMask) {
      for (const chunk of clean) code.push(chunk);
      distinctCodeMask = true;
    }
    clean.push(prefix, comment ? hidden : text.slice(start, end));
    if (distinctCodeMask) code.push(prefix, hidden);
    at = end;
    marker.lastIndex = end;
  }
  const tail = text.slice(at);
  clean.push(tail);
  const cleaned = clean.join('');
  if (distinctCodeMask) code.push(tail);
  return { text: cleaned, code: distinctCodeMask ? code.join('') : cleaned };
}

export function sourceRange(text, start, end, starts = null) {
  if (!starts) {
    starts = [0];
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  }
  const position = offset => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
  const first = position(start), last = position(end);
  return { startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column };
}

export function importBindings(rel, statement, specifier) {
  if (/\.java$/i.test(rel)) {
    const imported = specifier.split('.').pop();
    return imported === '*' ? [] : [{ imported, local: imported, kind: /\bimport\s+static\b/.test(statement) ? 'static' : 'named' }];
  }
  if (/\.py$/i.test(rel)) {
    const from = /\bfrom\s+[.\w]+\s+import\s+([\s\S]+)/.exec(statement);
    if (from) return namedBindings(from[1].replace(/[()]/g, ''), 'py');
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alias = new RegExp(`(?:^|[,\\s])${escaped}\\s+as\\s+(\\w+)`).exec(statement);
    return [{ imported: '*', local: alias?.[1] || specifier.split('.')[0], kind: 'module' }];
  }
  const clause = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]/.exec(statement)?.[1];
  if (clause !== undefined) {
    const bindings = [];
    const names = /\{([\s\S]*?)\}/.exec(clause);
    if (names) bindings.push(...namedBindings(names[1], 'js'));
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (namespace) bindings.push({ imported: '*', local: namespace[1], kind: 'namespace' });
    const defaultName = /^\s*([\w$]+)(?:\s*,|\s*$)/.exec(clause)?.[1];
    if (defaultName) bindings.unshift({ imported: 'default', local: defaultName, kind: 'default' });
    return /\bimport\s+type\b/.test(statement) ? bindings.map(binding => ({ ...binding, kind: 'type' })) : bindings;
  }
  const require = /(?:const|let|var)\s+(\{[^}]+\}|[\w$]+)\s*=\s*require\s*\(/.exec(statement);
  if (require) return require[1].startsWith('{') ? namedBindings(require[1].slice(1, -1), 'cjs') : [{ imported: '*', local: require[1], kind: 'namespace' }];
  return [];
}

function namedBindings(clause, syntax) {
  const output = [];
  for (const raw of clause.split(',')) {
    const value = raw.trim();
    const typeOnly = syntax === 'js' && /^type\s+/.test(value);
    const match = /^(?:type\s+)?([\w$]+)(?:\s+(?:as)\s+([\w$]+)|\s*:\s*([\w$]+))?$/.exec(value);
    if (match) output.push({ imported: match[1], local: match[2] || match[3] || match[1], kind: typeOnly ? 'type' : 'named' });
  }
  return output;
}

/** Import observations preserve source order and every occurrence, including duplicates. */
export function lexicalImportOccurrences(rel, input, masks = sourceMasks(rel, input)) {
  const result = [], text = masks.text;
  const starts = [0];
  for (let at = input.indexOf('\n'); at >= 0; at = input.indexOf('\n', at + 1)) starts.push(at + 1);
  const add = (match, specifier, statement = match[0]) => {
    if (result.length >= 257) return;
    const leading = match[0].search(/\S/), start = match.index + Math.max(0, leading);
    if (masks.code[start] !== input[start]) return;
    let prior = start - 1;
    while (prior >= 0 && /[ \t]/.test(masks.code[prior])) prior--;
    const previous = masks.code[prior];
    if (previous === '.' || /[\w$]/.test(masks.code[start - 1] || '')) return;
    result.push({ specifier, range: sourceRange(input, start, match.index + match[0].length, starts), bindings: importBindings(rel, statement, specifier), method: 'lexical', offset: start });
  };
  let match;
  if (/\.java$/i.test(rel)) {
    const pattern = /^[ \t]*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
    while ((match = pattern.exec(text))) add(match, match[1]);
  } else if (/\.py$/i.test(rel)) {
    const from = /^[ \t]*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n;]+)/gm;
    while ((match = from.exec(text))) add(match, match[1]);
    const imports = /^[ \t]*import\s+([^\n;]+)/gm;
    while ((match = imports.exec(text))) for (const item of match[1].split(',')) {
      const specifier = /^\s*([\w.]+)/.exec(item)?.[1];
      if (specifier) add(match, specifier);
    }
  } else if (/\.[cm]?[jt]sx?$/i.test(rel)) {
    const patterns = [
      /\b(?:import|export)\s+[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
      /\bimport\s*['"]([^'"\n]+)['"]/g,
      /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) while ((match = pattern.exec(text))) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      add(match, match[1], text.slice(lineStart, match.index + match[0].length));
    }
  }
  return result.sort((a, b) => a.offset - b.offset).map(({ offset, ...value }) => value);
}
