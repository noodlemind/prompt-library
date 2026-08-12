/**
 * Human-readable preview of a palette selection before it runs.
 * Product rule: one compact line (or needs:), never a multi-row key/value dump.
 * The run block already echoes the command — preview only clarifies intent.
 */
import { resolveSelection, containsFlagSyntax } from './palette.mjs';

/**
 * @param {object} row command-index row
 * @param {Record<string, string>} [values]
 * @returns {{ lines: string[], argv: string[]|null, invalid: string|null, skipLedger: boolean }}
 */
export function previewSelection(row, values = {}) {
  if (!row) return { lines: [], argv: null, invalid: 'no selection', skipLedger: true };
  const { argv, invalid, missing } = resolveSelection(row, values);
  if (missing?.length) {
    return {
      lines: [
        `needs: ${missing.map((k) => String(k).replace(/^--/, '')).join(', ')}`,
      ],
      argv: null,
      invalid: null,
      skipLedger: false,
    };
  }
  if (invalid || !argv) {
    return { lines: [], argv: null, invalid: invalid || 'cannot resolve', skipLedger: true };
  }

  // Ready selections: the ledger block already prints the command line.
  // Do not dump sparse "command / key / value / scope" rows into scrollback —
  // that is CLI form noise on a product surface.
  if (containsFlagSyntax(row.label || '')) {
    return {
      lines: ['note: label still contains flags — prefer human labels in the index'],
      argv,
      invalid: null,
      skipLedger: false,
    };
  }

  return { lines: [], argv, invalid: null, skipLedger: true };
}

/**
 * Format preview lines for the ledger style helper.
 * @param {{ line: Function }} ui
 * @param {ReturnType<typeof previewSelection>} preview
 */
export function renderPreviewLines(ui, preview) {
  if (!preview?.lines?.length) return [];
  return preview.lines.map((text) => {
    const [key, ...rest] = text.split(':');
    if (rest.length) {
      return ui.line({
        state: key.trim() === 'needs' ? 'warn' : 'pending',
        key: key.trim(),
        value: rest.join(':').trim(),
      });
    }
    return ui.line({ key: 'preview', value: text });
  });
}
