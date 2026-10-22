import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { renderDiagram } from '../lib/diagrams/render.mjs';

const source = 'flowchart TB\n A[Engineer authors] --> B[Harness validates]\n B --> C[Local SVG]';

test('Pele renders portable, deterministic SVG without a browser', async () => {
  const first = await renderDiagram({ source, engine: 'pele' });
  const second = await renderDiagram({ source, engine: 'pele' });
  assert.equal(first.engine, 'pele');
  assert.equal(first.version, '1.8.0');
  assert.equal(first.layout, null);
  assert.match(first.svg, /^<svg\s/);
  assert.match(first.svg, /Engineer authors/);
  assert.doesNotMatch(first.svg, /var\(--|<script|<foreignObject|<image|\son\w+\s*=/i);
  assert.equal(first.svg, second.svg);
  assert.equal(first.settings.network, 'disabled');
});

test('supported Mermaid behavior and data views render through the same bounded worker', async () => {
  for (const input of [
    'stateDiagram-v2\n [*] --> Ready\n Ready --> Done: finish\n Done --> [*]',
    'sequenceDiagram\n participant E as Engineer\n participant H as Harness\n E->>H: render\n H-->>E: SVG',
    'erDiagram\n SOURCE ||--o{ VIEW : supports',
    'classDiagram\n class View\n class Source\n Source --> View',
  ]) assert.match((await renderDiagram({ source: input, engine: 'pele' })).svg, /^<svg\s/);
});

test('encoded projection labels remain data while actual click directives are refused', async () => {
  const encoded = 'flowchart TB\n A["file#10;click A#32;#34;https#58;#47;#47;example#46;com#34;"] --> B[View]';
  assert.match((await renderDiagram({ source: encoded, engine: 'pele' })).svg, /file/);
  await assert.rejects(renderDiagram({ source: `${encoded}; click A "https://example.com"`, engine: 'pele' }), /not supported/i);
});

test('bundled D2 provides all three layouts and releases its internal worker', { timeout: 30_000 }, async () => {
  for (const layout of ['dagre', 'elk', 'tala']) {
    const result = await renderDiagram({ source: 'direction: down\n host: Engineer\n harness: Harness\n host -> harness: authors view', engine: 'd2', layout });
    assert.equal(result.version, '0.1.34');
    assert.equal(result.layout, layout);
    assert.match(result.svg, /^<svg\s/);
    assert.match(result.svg, /Engineer/);
    assert.doesNotMatch(result.svg, /<script|<foreignObject|<image|\son\w+\s*=/i);
  }
});

test('D2 TALA output is reproducible across independent renderer workers', { timeout: 30_000 }, async () => {
  const input = { source: 'a: Source\nb: View\na -> b', engine: 'd2', layout: 'tala' };
  assert.equal((await renderDiagram(input)).svg, (await renderDiagram(input)).svg);
});

test('renderer input and resource options fail explicitly', async () => {
  for (const input of [
    { source, engine: 'remote' }, { source, engine: 'd2', layout: 'external' },
    { source: '', engine: 'pele' }, { source: 'x'.repeat(50_001), engine: 'pele' },
    { source, engine: 'pele', timeoutMs: 0 }, { source, engine: 'pele', timeoutMs: Infinity },
    { source, engine: 'pele', timeoutMs: 30_001 }, { source: 'flowchart LR\n A\0B', engine: 'pele' },
  ]) await assert.rejects(renderDiagram(input), error => error.code === 'E_DIAGRAM_RENDER');
});

test('Pele rejects irrelevant layout controls and styling directives while keeping label words and class declarations', async () => {
  await assert.rejects(renderDiagram({ source, engine: 'pele', layout: 'tala' }), /layout.*D2|layout.*d2/i);
  for (const directive of ['style A fill:red', 'classDef hot fill:red', 'linkStyle 0 stroke:red']) {
    await assert.rejects(renderDiagram({ source: `${source}\n${directive}`, engine: 'pele' }), /not supported/i);
  }
  const label = 'flowchart LR\n A["style classDef linkStyle are label words"] --> B[View]';
  assert.match((await renderDiagram({ source: label, engine: 'pele' })).svg, /label words/);
  assert.match((await renderDiagram({ source: 'classDiagram\n class View\n class Source\n Source --> View', engine: 'pele' })).svg, /View/);
});

test('unsupported Mermaid directives, external assets and styles have clear diagnostics', async () => {
  for (const input of [
    '---\nconfig: {}\n---\nflowchart LR\n A --> B',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A --> B',
    'flowchart LR\n A --> B\n click A "https://example.com"',
    'flowchart LR\n A[<img src="https://example.com/x">] --> B',
    'flowchart LR\n A@{ img: "https://example.com/x" }',
    'flowchart LR\n A --> B\n classDef danger fill:url(https://example.com/x)',
    'flowchart LR\n A --> B\n classDef danger fill:u\\72l(https\\3a//example.com/x)',
    'gantt\n title Outside the supported view types',
  ]) await assert.rejects(renderDiagram({ source: input, engine: 'pele' }), /unsupported|not supported|forbidden/i);
});

test('D2 forbids external imports and configuration even through quoted or escaped keys', async () => {
  for (const input of [
    'a: @outside', 'a: { icon: https://example.com/x.svg }',
    'a: { "icon": "file:///etc/passwd" }', 'a: { "\\u0069con": "https://example.com/x" }',
    'a: { link: https://example.com }', 'vars: { d2-config: { layout-engine: external } }',
    'a: { label: |md\n![x](https://example.com/x)\n| }',
    'a: { style.fill: "url(https://example.com/x)" }',
  ]) await assert.rejects(renderDiagram({ source: input, engine: 'd2' }), /unsupported|not supported|forbidden/i);
});

test('renderer syntax errors and a hard deadline reject without hanging', async () => {
  await assert.rejects(renderDiagram({ source: 'flowchart LR\n A[unfinished', engine: 'pele' }), /render|syntax|parse/i);
  await assert.rejects(renderDiagram({ source: 'a: {', engine: 'd2' }), /render|terminated|parse/i);
  await assert.rejects(renderDiagram({ source: `flowchart LR\n${'A --> B\n'.repeat(2049)}`, engine: 'pele' }), /limit|edges/i);
  await assert.rejects(renderDiagram({ source, engine: 'pele', timeoutMs: 1 }), /timed out/i);
});

test('network guard blocks actual outgoing requests inside a nested worker', async t => {
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.end('probe'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await (await fetch(endpoint)).text(), 'probe', 'positive control must reach the fixture');
  const workerModule = new URL('../lib/diagrams/render-worker.mjs', import.meta.url).href;
  // Use a module worker like production: early Node 20 crashes when this guard
  // is dynamically imported and invoked from a CommonJS eval worker.
  const probeSource = `import { parentPort } from 'node:worker_threads';
    (async () => {
      const { installRendererNetworkGuard, guardNestedRendererWorkers } = await import(${JSON.stringify(workerModule)});
      await installRendererNetworkGuard(); await guardNestedRendererWorkers();
      const { Worker } = await import('node:worker_threads');
      const nested = new Worker(\`const {parentPort}=require('node:worker_threads');
        (async()=>{const results=[];
          for(const probe of [()=>fetch(${JSON.stringify(endpoint)}),
            ()=>require('node:http').get(${JSON.stringify(endpoint)}),
            ()=>require('node:net').connect({host:'127.0.0.1',port:${server.address().port}})]) {
            try{await probe();results.push('connected');}catch(error){results.push(error.code||error.message);}
          }parentPort.postMessage(JSON.stringify(results));})();\`, {eval:true});
      nested.on('message', message => {parentPort.postMessage(JSON.stringify({ checks:JSON.parse(message), limits:nested.resourceLimits }));nested.terminate();});
    })().catch(error=>parentPort.postMessage(error.message));`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(probeSource)}`), { execArgv: [] });
  t.after(() => worker.terminate());
  const [message] = await once(worker, 'message');
  const result = JSON.parse(message);
  assert.deepEqual(result.checks, ['E_DIAGRAM_NETWORK', 'E_DIAGRAM_NETWORK', 'E_DIAGRAM_NETWORK']);
  assert.equal(result.limits.maxOldGenerationSizeMb, 128);
  assert.equal(result.limits.stackSizeMb, 4);
  assert.equal(requests, 1, 'only the positive control may reach the server');
});

test('ordinary Node CLI process exits after a D2 render without a server or cleanup handoff', () => {
  const module = new URL('../lib/diagrams/render.mjs', import.meta.url).href;
  const script = `import {renderDiagram} from ${JSON.stringify(module)};
    const result=await renderDiagram({engine:'d2',source:'a -> b'});console.log(result.engine);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'd2');
});
