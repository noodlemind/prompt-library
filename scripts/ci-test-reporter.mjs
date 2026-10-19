import path from 'node:path';

export default async function* timings(events) {
  for await (const { type, data } of events) {
    if (type === 'test:complete' && data.nesting === 0 && data.file && path.resolve(data.name) === path.resolve(data.file)) {
      yield JSON.stringify({ kind: 'file', file: path.basename(data.file), durationMs: data.details.duration_ms, passed: data.details.passed === true }) + '\n';
    }
    if (type === 'test:summary' && !data.file) {
      yield JSON.stringify({ kind: 'summary', counts: data.counts, durationMs: data.duration_ms, success: data.success }) + '\n';
    }
  }
}
