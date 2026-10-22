import { Worker } from 'node:worker_threads';

const MAX_INPUT_BYTES = 50_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const LAYOUTS = ['tala', 'elk', 'dagre'];

function failure(message) {
  return Object.assign(new Error(`diagram render: ${message}`), { code: 'E_DIAGRAM_RENDER', exit: 1 });
}

// This intentionally supports a static subset, not arbitrary renderer configuration.
// The worker separately disables networking, including inside D2's nested worker.
function validateSource(source, engine) {
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') || Buffer.byteLength(source) > MAX_INPUT_BYTES) {
    throw failure(`source must be nonempty text without NUL bytes, at most ${MAX_INPUT_BYTES} bytes`);
  }
  const decoded = source.replace(/\\u\{([\da-f]{1,6})\}/gi, (_, digits) => {
    const value = Number.parseInt(digits, 16);
    return value <= 0x10ffff ? String.fromCodePoint(value) : '';
  }).replace(/\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, unicode, byte) => String.fromCharCode(Number.parseInt(unicode || byte, 16)))
    .replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?/gi, (_, digits) => {
      const value = Number.parseInt(digits, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/\\(.)/gs, '$1').replace(/["'`]/g, '');
  if (/(?:https?|ftp|file|data|javascript|vbscript|mailto|tel)\s*:|url\s*\(|!\s*\[|<\s*\/?\s*[a-z!]/i.test(decoded)) {
    throw failure('external URLs, assets, markup and CSS URL values are not supported');
  }
  if (engine === 'pele') {
    // Mermaid numeric entities are label data, including their terminating ';'.
    const syntax = source.replace(/#\d+;/g, 'X');
    const header = source.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('%%')) || '';
    if (!/^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|erDiagram|classDiagram)\b/.test(header)) {
      throw failure('unsupported Mermaid view type; use flowchart, state, sequence, ER or class diagrams');
    }
    if (/%%\s*\{|^\s*---|(?:^|[;\n])\s*(?:click|style|classDef|linkStyle)[\t ]+|@\s*\{|\$\$|(?:^|\W)(?:fa|fab|fas|icon):/im.test(syntax)) {
      throw failure('Mermaid configuration, styling, click directives, external icons, images and math are not supported');
    }
  } else if (/[@$|]|\b(?:icon|link|tooltip|vars|classes|class)\s*[:{]|\bshape\s*:\s*image\b/i.test(decoded)) {
    throw failure('D2 imports, variables, configuration, classes, markup, links and image assets are not supported');
  }
}

/** Render authored static diagram source using only the libraries shipped with AE. */
export async function renderDiagram({ source, engine = 'pele', layout, timeoutMs = 10_000 } = {}) {
  if (!['pele', 'd2'].includes(engine)) throw failure('engine must be pele or d2');
  if (engine === 'pele' && layout !== undefined) throw failure('layout controls are supported only for D2');
  if (layout !== undefined && !LAYOUTS.includes(layout)) throw failure('layout must be tala, elk or dagre');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw failure(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  validateSource(source, engine);
  const worker = new Worker(new URL('./render-worker.mjs', import.meta.url), {
    workerData: { source, engine, layout: engine === 'd2' ? layout || 'tala' : null, maxOutputBytes: MAX_OUTPUT_BYTES },
    execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  // Renderer diagnostics are reported through the bounded result, never as raw output.
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); worker.removeAllListeners();
      try { await worker.terminate(); }
      catch (cause) { error ||= failure(`worker cleanup failed: ${cause.message}`); }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(failure(`timed out after ${timeoutMs}ms`)), timeoutMs);
    worker.once('error', error => finish(failure(error.message)));
    worker.once('exit', code => finish(failure(`worker exited before returning a result (code ${code})`)));
    worker.once('message', message => {
      if (message?.error) return finish(failure(String(message.error).slice(0, 2000)));
      if (!message?.result || typeof message.result.svg !== 'string' || Buffer.byteLength(message.result.svg) > MAX_OUTPUT_BYTES) {
        return finish(failure('renderer returned an invalid or oversized result'));
      }
      return finish(null, message.result);
    });
  });
}
