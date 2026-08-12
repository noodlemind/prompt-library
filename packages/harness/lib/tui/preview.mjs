/**
 * Human-readable preview of a palette selection before it runs.
 * Shows the canonical argv (for scripts) without forcing the user to type flags.
 */
import { resolveSelection, containsFlagSyntax } from './palette.mjs';

/**
 * @param {object} row command-index row
 * @param {Record<string, string>} [values]
 * @returns {{ lines: string[], argv: string[]|null, invalid: string|null }}
 */
export function previewSelection(row, values = {}) {
  if (!row) return { lines: [], argv: null, invalid: 'no selection' };
  const { argv, invalid, missing } = resolveSelection(row, values);
  if (missing?.length) {
    return {
      lines: [
        `needs: ${missing.map((k) => String(k).replace(/^--/, '')).join(', ')}`,
      ],
      argv: null,
      invalid: null,
    };
  }
  if (invalid || !argv) {
    return { lines: [], argv: null, invalid: invalid || 'cannot resolve' };
  }

  const lines = [];
  lines.push(`command: ${argv.join(' ')}`);

  // Config set — surface key / value / scope without making the user type them.
  if (argv[0] === 'config' && argv[1] === 'set') {
    const key = argv[2];
    const value = argv[3];
    let scope = 'user';
    const si = argv.indexOf('--scope');
    if (si !== -1 && argv[si + 1]) scope = argv[si + 1];
    if (key) lines.push(`key: ${key}`);
    if (value !== undefined) lines.push(`value: ${value}`);
    lines.push(`scope: ${scope}`);
  }

  // Labels in the palette must not teach flag soup.
  if (row.label && containsFlagSyntax(row.label)) {
    lines.push('note: label still contains flags — prefer human labels in the index');
  }

  return { lines, argv, invalid: null };
}

/**
 * Format preview lines for the ledger style helper.
 * @param {{ line: Function }} ui
 * @param {ReturnType<typeof previewSelection>} preview
 */
export function renderPreviewLines(ui, preview) {
  if (!preview?.lines?.length) return [];
  return preview.lines.map((text, i) => {
    const [key, ...rest] = text.split(':');
    if (rest.length) {
      return ui.line({
        state: i === 0 ? 'pending' : undefined,
        key: key.trim(),
        value: rest.join(':').trim(),
      });
    }
    return ui.line({ key: 'preview', value: text });
  });
}
