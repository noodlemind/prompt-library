import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DockerPolicyError,
  DockerProxyPolicy,
  createDockerPolicyProxy,
  relayHijackedTransport,
} from '../../../evals/runtime/docker-proxy.mjs';

const LEASE = 'lease-20260804-a';
const PROJECT = 'engineer-eval-lease-20260804-a';
const CONTAINER_NAME = `${PROJECT}-task-1`;
const IMAGE = `registry.example.invalid/evals/cobol@sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const EXEC_ID = 'c'.repeat(64);

const policyOptions = (overrides = {}) => ({
  leaseId: LEASE,
  pinnedImage: IMAGE,
  composeProject: PROJECT,
  containerName: CONTAINER_NAME,
  leaseLabel: 'com.engineer-harness.eval.lease',
  resources: {
    nanoCpus: 1_000_000_000,
    memoryBytes: 2_147_483_648,
    pidsLimit: 128,
  },
  requireReadOnlyRootfs: true,
  allowedArchivePaths: ['/workspace', '/logs'],
  maxJsonBodyBytes: 32 * 1024,
  maxArchiveBodyBytes: 2 * 1024 * 1024,
  ...overrides,
});

function createBody(overrides = {}) {
  const body = {
    Image: IMAGE,
    Labels: {
      'com.engineer-harness.eval.lease': LEASE,
      'com.docker.compose.project': PROJECT,
      'com.docker.compose.service': 'task',
    },
    HostConfig: {
      NetworkMode: 'none',
      Privileged: false,
      ReadonlyRootfs: true,
      NanoCpus: 1_000_000_000,
      Memory: 2_147_483_648,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Devices: [],
      DeviceRequests: [],
      Binds: [],
      Mounts: [],
      VolumesFrom: [],
    },
    NetworkingConfig: { EndpointsConfig: {} },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(body));
}

function request(policy, method, target, body = Buffer.alloc(0), headers = {}) {
  const normalizedHeaders = { ...headers };
  if (body.length && normalizedHeaders['content-length'] == null && normalizedHeaders['transfer-encoding'] == null) {
    normalizedHeaders['content-length'] = String(body.length);
  }
  const rawHeaders = Object.entries(normalizedHeaders).flatMap(([name, value]) => [name, String(value)]);
  return policy.authorize({ method, target, headers: normalizedHeaders, rawHeaders, body });
}

function bindContainer(policy) {
  const decision = request(
    policy,
    'POST',
    `/v1.47/containers/create?name=${encodeURIComponent(CONTAINER_NAME)}`,
    createBody(),
    { 'content-type': 'application/json' }
  );
  policy.observeResponse(decision, {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ Id: CONTAINER_ID, Warnings: [] })),
  });
  return decision;
}

function bindExec(policy) {
  bindContainer(policy);
  const body = Buffer.from(JSON.stringify({ Cmd: ['/bin/sh', '-lc', 'true'], Privileged: false }));
  const decision = request(policy, 'POST', `/containers/${CONTAINER_ID}/exec`, body, {
    'content-type': 'application/json',
  });
  policy.observeResponse(decision, {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ Id: EXEC_ID })),
  });
}

function expectDenied(fn, pattern = /denied|invalid|not allowed|must/i) {
  assert.throws(fn, (error) => error instanceof DockerPolicyError && pattern.test(error.message));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

test('emits a canonical content-free audit chain for allow, response, binding, denial, and cleanup', () => {
  const policy = new DockerProxyPolicy(policyOptions({ maxAuditEvents: 64 }));
  bindExec(policy);

  const sensitivePath = '/private/customer-alpha/card-data';
  const sensitiveBody = 'sk-do-not-retain-this-request-body';
  expectDenied(() => request(
    policy,
    'PUT',
    `/containers/${CONTAINER_ID}/archive?path=${encodeURIComponent(sensitivePath)}`,
    Buffer.from(sensitiveBody),
    { 'content-type': 'application/x-tar' }
  ), /archive|allowlist/i);

  const deletion = request(policy, 'DELETE', `/containers/${CONTAINER_ID}?force=true&v=true`);
  policy.observeResponse(deletion, { statusCode: 204, headers: {}, body: Buffer.alloc(0) });

  const audit = policy.auditSnapshot();
  assert.equal(audit.schema, 'engineer-harness/docker-proxy-audit/v1');
  assert.equal(audit.hashAlgorithm, 'sha256');
  assert.equal(audit.canonicalization, 'recursive-key-sort-json-v1');
  assert.equal(audit.complete, true);
  assert.equal(audit.droppedEvents, 0);
  assert.equal(audit.totalEvents, audit.events.length);
  assert.deepEqual(audit.state, {
    cleanupComplete: true,
    containerBound: false,
    containerBindingHash: null,
    createPending: false,
    execBindingCount: 0,
    execBindingHashes: [],
    leaseTerminated: true,
  });

  const serialized = JSON.stringify(audit);
  for (const forbidden of [sensitivePath, 'customer-alpha', sensitiveBody, LEASE, CONTAINER_NAME, IMAGE, CONTAINER_ID, EXEC_ID]) {
    assert.equal(serialized.includes(forbidden), false, `audit retained forbidden content: ${forbidden}`);
  }
  assert.ok(audit.events.some((event) => event.phase === 'request' && event.outcome === 'allowed' && event.kind === 'container-create'));
  assert.ok(audit.events.some((event) => event.phase === 'response' && event.kind === 'exec-create' && event.statusCode === 201));
  assert.ok(audit.events.some((event) => event.phase === 'request' && event.outcome === 'denied' && event.code === 'ARCHIVE_POLICY'));
  assert.ok(audit.events.some((event) => event.phase === 'state' && event.action === 'container-bound'));
  assert.ok(audit.events.some((event) => event.phase === 'state' && event.action === 'exec-bound'));
  assert.ok(audit.events.some((event) => event.phase === 'state' && event.action === 'container-cleaned'));

  let previousHash = '0'.repeat(64);
  for (const event of audit.events) {
    assert.equal(event.previousHash, previousHash);
    const { eventHash, ...canonicalEvent } = event;
    assert.equal(eventHash, canonicalHash(canonicalEvent));
    previousHash = eventHash;
  }
  assert.equal(audit.tailHash, previousHash);
  const { evidenceHash, ...canonicalEvidence } = audit;
  assert.equal(evidenceHash, canonicalHash(canonicalEvidence));

  audit.events[0].outcome = 'tampered';
  assert.notEqual(policy.auditSnapshot().events[0].outcome, 'tampered');
});

test('bounds retained audit evidence and makes truncation explicit without breaking the hash anchor', () => {
  const policy = new DockerProxyPolicy(policyOptions({ maxAuditEvents: 3 }));
  for (let index = 0; index < 8; index += 1) {
    expectDenied(() => request(policy, 'GET', `/forbidden-${index}`));
  }

  const audit = policy.auditSnapshot();
  assert.equal(audit.complete, false);
  assert.equal(audit.totalEvents, 8);
  assert.equal(audit.events.length, 3);
  assert.equal(audit.droppedEvents, 5);
  assert.equal(audit.retainedFromSequence, 6);
  assert.equal(audit.events[0].previousHash, audit.anchorHash);
  assert.equal(audit.eventCounts['request.denied'], 8);
  assert.equal(JSON.stringify(audit).includes('/forbidden-'), false);
  const { evidenceHash, ...canonicalEvidence } = audit;
  assert.equal(evidenceHash, canonicalHash(canonicalEvidence));
  assert.throws(() => new DockerProxyPolicy(policyOptions({ maxAuditEvents: 4_097 })), /maxAuditEvents.*4096/i);
});

test('exposes the sanitized audit snapshot through the production proxy instance', () => {
  const proxy = createDockerPolicyProxy({
    listenSocketPath: '/tmp/engineer-audit-proxy.sock',
    upstreamSocketPath: '/tmp/engineer-audit-upstream.sock',
    policy: policyOptions(),
  });
  expectDenied(() => request(proxy.policy, 'POST', '/auth'));
  assert.deepEqual(proxy.auditSnapshot(), proxy.policy.auditSnapshot());
  assert.match(proxy.auditSnapshot().evidenceHash, /^[a-f0-9]{64}$/);
});

test('normalizes one optional Docker API version and allows only the offline global surface', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  assert.equal(request(policy, 'HEAD', '/v1.47/_ping').normalizedTarget, '/_ping');
  assert.equal(request(policy, 'GET', '/version').kind, 'version');
  assert.equal(request(policy, 'GET', '/v1.24/info').kind, 'info');

  for (const [method, target] of [
    ['GET', '/_ping'],
    ['POST', '/version'],
    ['GET', '/events'],
    ['GET', '/system/df'],
    ['POST', '/auth'],
  ]) {
    expectDenied(() => request(policy, method, target));
  }
});

test('validates create policy before forwarding and binds the returned container id', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const decision = bindContainer(policy);
  assert.equal(decision.kind, 'container-create');
  assert.deepEqual(policy.snapshot(), { containerId: CONTAINER_ID, execIds: [] });

  assert.equal(request(policy, 'GET', `/containers/${CONTAINER_ID}/json`).kind, 'container-inspect');
  assert.equal(request(policy, 'POST', `/containers/${CONTAINER_ID}/start`).kind, 'container-start');
  assert.equal(request(policy, 'POST', `/containers/${CONTAINER_ID}/stop?t=10`).kind, 'container-stop');
  expectDenied(() => request(policy, 'GET', `/containers/${'d'.repeat(64)}/json`), /foreign/i);
});

test('container binds must match one complete condition-specific set', () => {
  const common = '/engineer-bounded/work/mounts/000:/opt/eval-runtime/node-x64:ro';
  const treatment = '/engineer-bounded/work/mounts/005:/opt/harness-bundle/harness:ro';
  const authorizeBinds = (binds) => request(
    new DockerProxyPolicy(policyOptions({
      allowedBindSets: [[common], [common, treatment]],
    })),
    'POST',
    `/containers/create?name=${CONTAINER_NAME}`,
    createBody({
      HostConfig: { ...JSON.parse(createBody()).HostConfig, Binds: binds },
    }),
    { 'content-type': 'application/json' },
  );
  assert.equal(authorizeBinds([common]).kind, 'container-create');
  expectDenied(() => authorizeBinds([]), /complete allowed set/i);
  expectDenied(() => authorizeBinds([treatment]), /complete allowed set|allowlist/i);
  expectDenied(() => authorizeBinds([common, common]), /duplicate-free/i);
});

test('rejects every security-sensitive create-policy drift', () => {
  const drifts = [
    ['unpinned image', { Image: 'alpine:latest' }],
    ['host network', { HostConfig: { ...JSON.parse(createBody()).HostConfig, NetworkMode: 'host' } }],
    ['privileged', { HostConfig: { ...JSON.parse(createBody()).HostConfig, Privileged: true } }],
    ['capability add', { HostConfig: { ...JSON.parse(createBody()).HostConfig, CapAdd: ['SYS_ADMIN'] } }],
    ['missing ALL drop', { HostConfig: { ...JSON.parse(createBody()).HostConfig, CapDrop: [] } }],
    ['device', { HostConfig: { ...JSON.parse(createBody()).HostConfig, Devices: [{ PathOnHost: '/dev/kvm' }] } }],
    ['docker socket bind', { HostConfig: { ...JSON.parse(createBody()).HostConfig, Binds: ['/var/run/docker.sock:/sock'] } }],
    ['writable root', { HostConfig: { ...JSON.parse(createBody()).HostConfig, ReadonlyRootfs: false } }],
    ['cpu drift', { HostConfig: { ...JSON.parse(createBody()).HostConfig, NanoCpus: 2_000_000_000 } }],
    ['memory drift', { HostConfig: { ...JSON.parse(createBody()).HostConfig, Memory: 1 } }],
    ['pid drift', { HostConfig: { ...JSON.parse(createBody()).HostConfig, PidsLimit: 0 } }],
    ['missing no-new-privileges', { HostConfig: { ...JSON.parse(createBody()).HostConfig, SecurityOpt: [] } }],
    ['foreign compose project', { Labels: { ...JSON.parse(createBody()).Labels, 'com.docker.compose.project': 'foreign' } }],
    ['missing lease label', { Labels: { 'com.docker.compose.project': PROJECT } }],
    ['network endpoint', { NetworkingConfig: { EndpointsConfig: { bridge: {} } } }],
    ['host cgroup namespace', { HostConfig: { ...JSON.parse(createBody()).HostConfig, CgroupnsMode: 'host' } }],
    ['disabled read-only kernel paths', { HostConfig: { ...JSON.parse(createBody()).HostConfig, ReadonlyPaths: [] } }],
    ['disabled masked kernel paths', { HostConfig: { ...JSON.parse(createBody()).HostConfig, MaskedPaths: [] } }],
    ['external log driver', { HostConfig: { ...JSON.parse(createBody()).HostConfig, LogConfig: { Type: 'syslog', Config: { 'syslog-address': 'tcp://attacker.invalid:514' } } } }],
    ['restart persistence', { HostConfig: { ...JSON.parse(createBody()).HostConfig, RestartPolicy: { Name: 'always' } } }],
  ];

  for (const [name, override] of drifts) {
    const policy = new DockerProxyPolicy(policyOptions());
    expectDenied(
      () => request(
        policy,
        'POST',
        `/containers/create?name=${CONTAINER_NAME}`,
        createBody(override),
        { 'content-type': 'application/json' }
      ),
      /create|image|network|privileged|cap|device|mount|root|cpu|memory|pid|security|label|lease|endpoint|cgroup|log|restart/i
    );
  }
});

test('rejects Docker case-folding aliases across the container-create policy surface', () => {
  const aliases = [
    ['privileged', true],
    ['bInDs', ['/var/run/docker.sock:/sock']],
    ['networkmode', 'host'],
    ['sEcUrItYoPt', ['seccomp=unconfined']],
    ['readonlypaths', []],
    ['mAsKeDpAtHs', []],
  ];

  for (const [field, value] of aliases) {
    const host = { ...JSON.parse(createBody()).HostConfig, [field]: value };
    expectDenied(
      () => request(
        new DockerProxyPolicy(policyOptions()),
        'POST',
        `/containers/create?name=${CONTAINER_NAME}`,
        createBody({ HostConfig: host }),
        { 'content-type': 'application/json' },
      ),
      /canonical|duplicate|create/i,
    );
  }

  expectDenied(
    () => request(
      new DockerProxyPolicy(policyOptions()),
      'POST',
      `/containers/create?name=${CONTAINER_NAME}`,
      createBody({ image: 'alpine:latest' }),
      { 'content-type': 'application/json' },
    ),
    /canonical|duplicate|create/i,
  );
  expectDenied(
    () => request(
      new DockerProxyPolicy(policyOptions()),
      'POST',
      `/containers/create?name=${CONTAINER_NAME}`,
      createBody({ HostConfig: { ...JSON.parse(createBody()).HostConfig, FutureDaemonEscape: true } }),
      { 'content-type': 'application/json' },
    ),
    /canonical|create/i,
  );
});

test('container and image lists require exact filters scoped to this lease', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const composeFilters = encodeURIComponent(JSON.stringify({
    label: [`com.docker.compose.project=${PROJECT}`],
  }));
  assert.equal(request(policy, 'GET', `/containers/json?all=1&filters=${composeFilters}`).kind, 'container-list');

  const imageFilters = encodeURIComponent(JSON.stringify({ reference: [IMAGE] }));
  assert.equal(request(policy, 'GET', `/images/json?filters=${imageFilters}`).kind, 'image-list');
  assert.equal(request(policy, 'GET', `/images/${encodeURIComponent(IMAGE)}/json`).kind, 'image-inspect');

  for (const target of [
    '/containers/json?all=1',
    `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=foreign'] }))}`,
    `/containers/json?filters=${encodeURIComponent(JSON.stringify({ status: ['running'] }))}`,
    `/images/json?filters=${encodeURIComponent(JSON.stringify({ reference: ['alpine:latest'] }))}`,
  ]) expectDenied(() => request(policy, 'GET', target), /filter|scope|project|image/i);
});

test('allows only empty, Compose-scoped network and volume discovery', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }));
  const networkDecision = request(policy, 'GET', `/networks?filters=${filters}`);
  const volumeDecision = request(policy, 'GET', `/volumes?filters=${filters}`);
  assert.equal(networkDecision.kind, 'network-list');
  assert.equal(volumeDecision.kind, 'volume-list');
  policy.observeResponse(networkDecision, { statusCode: 200, headers: {}, body: Buffer.from('[]') });
  policy.observeResponse(volumeDecision, { statusCode: 200, headers: {}, body: Buffer.from('{"Volumes":[],"Warnings":null}') });

  const foreign = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=foreign'] }));
  expectDenied(() => request(policy, 'GET', `/networks?filters=${foreign}`), /scope|project/i);
  expectDenied(() => policy.observeResponse(networkDecision, {
    statusCode: 200,
    headers: {},
    body: Buffer.from('[{"Id":"foreign"}]'),
  }), /network/i);
});

test('binds exec ids to the active container and rejects foreign container and exec ids', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  bindExec(policy);
  assert.deepEqual(policy.snapshot(), { containerId: CONTAINER_ID, execIds: [EXEC_ID] });

  const start = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
  assert.equal(request(policy, 'POST', `/exec/${EXEC_ID}/start`, start, {
    'content-type': 'application/json',
  }).kind, 'exec-start');
  expectDenied(() => request(policy, 'POST', `/exec/${'d'.repeat(64)}/start`, start), /foreign/i);
  expectDenied(() => request(policy, 'POST', `/containers/${'d'.repeat(64)}/exec`, Buffer.from('{}')), /foreign/i);
});

test('allows bounded archive operations only on normalized allowlisted paths', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  bindContainer(policy);
  const tar = Buffer.from('fixture tar bytes');
  assert.equal(request(policy, 'HEAD', `/containers/${CONTAINER_ID}/archive?path=%2Fworkspace`).kind, 'archive-head');
  assert.equal(request(policy, 'PUT', `/containers/${CONTAINER_ID}/archive?path=%2Fworkspace%2Fsrc`, tar, {
    'content-type': 'application/x-tar',
    'transfer-encoding': 'chunked',
  }).kind, 'archive-put');

  for (const archivePath of ['/etc', '/../etc', '/workspace/../../etc', '/workspace%00/evil']) {
    expectDenied(
      () => request(policy, 'HEAD', `/containers/${CONTAINER_ID}/archive?path=${encodeURIComponent(archivePath)}`),
      /archive|path|control|normalized/i
    );
  }
  expectDenied(
    () => request(policy, 'PUT', `/containers/${CONTAINER_ID}/archive?path=%2Fworkspace`, Buffer.alloc(2 * 1024 * 1024 + 1)),
    /body|large/i
  );
});

test('requires forced deletion and clears all dynamic bindings after success', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  bindExec(policy);
  expectDenied(() => request(policy, 'DELETE', `/containers/${CONTAINER_ID}`), /force/i);
  const decision = request(policy, 'DELETE', `/containers/${CONTAINER_ID}?force=true&v=true`);
  assert.equal(decision.kind, 'container-delete');
  policy.observeResponse(decision, { statusCode: 204, headers: {}, body: Buffer.alloc(0) });
  assert.deepEqual(policy.snapshot(), { containerId: null, execIds: [] });
  expectDenied(() => request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, createBody(), {
    'content-type': 'application/json',
  }), /deleted/i);
});

test('reserves the single container slot while create is in flight', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const body = createBody();
  const decision = request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, body, {
    'content-type': 'application/json',
  });
  expectDenied(() => request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, body, {
    'content-type': 'application/json',
  }), /pending/i);
  policy.observeResponse(decision, { statusCode: 409, headers: {}, body: Buffer.from('{}') });
  assert.equal(request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, body, {
    'content-type': 'application/json',
  }).kind, 'container-create');
});

test('releases a create reservation when the upstream request cannot be forwarded', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-forward-'));
  const upstreamPath = path.join(root, 'upstream.sock');
  const proxyPath = path.join(root, 'proxy.sock');
  const upstream = http.createServer((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  await new Promise((resolve, reject) => upstream.listen(upstreamPath, (error) => error ? reject(error) : resolve()));
  const proxy = createDockerPolicyProxy({
    listenSocketPath: proxyPath,
    upstreamSocketPath: upstreamPath,
    policy: policyOptions(),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => upstream.close(resolve));

  const response = await new Promise((resolve, reject) => {
    const body = createBody();
    const req = http.request({
      socketPath: proxyPath,
      method: 'POST',
      path: `/containers/create?name=${CONTAINER_NAME}`,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
      },
    }, resolve);
    req.once('error', reject);
    req.end(body);
  });
  await new Promise((resolve) => response.resume().once('end', resolve));

  assert.equal(response.statusCode, 502);
  assert.equal(proxy.auditSnapshot().state.createPending, false);
  assert.equal(request(
    proxy.policy,
    'POST',
    `/containers/create?name=${CONTAINER_NAME}`,
    createBody(),
    { 'content-type': 'application/json' },
  ).kind, 'container-create');
});

test('handles a post-start listener error durably and fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-policy-listener-error-'));
  const upstreamPath = path.join(root, 'upstream.sock');
  const proxyPath = path.join(root, 'proxy.sock');
  const upstream = http.createServer((_request, response) => response.end());
  await new Promise((resolve, reject) => upstream.listen(upstreamPath, (error) => error ? reject(error) : resolve()));
  const proxy = createDockerPolicyProxy({
    listenSocketPath: proxyPath,
    upstreamSocketPath: upstreamPath,
    policy: policyOptions(),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.doesNotThrow(() => proxy.server.emit('error', Object.assign(new Error('synthetic listener failure'), {
    code: 'EMFILE',
  })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(proxy.server.listening, false);
  assert.ok(proxy.auditSnapshot().events.some(
    (event) => event.phase === 'proxy' && event.action === 'listener-failed',
  ));
});

test('denies pulls, builds, image deletion, network/volume creation, and daemon mutation', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  for (const [method, target] of [
    ['POST', '/images/create?fromImage=alpine'],
    ['POST', '/build'],
    ['DELETE', `/images/${encodeURIComponent(IMAGE)}`],
    ['POST', '/networks/create'],
    ['POST', '/volumes/create'],
    ['POST', '/plugins/pull'],
    ['POST', '/swarm/init'],
    ['POST', '/containers/prune'],
    ['POST', '/commit'],
  ]) expectDenied(() => request(policy, method, target));
});

test('rejects ambiguous encodings, traversal, duplicate query/header fields, and framing smuggling', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const malformedTargets = [
    'http://localhost/version',
    '//version',
    '/v1.47/../info',
    '/v1.47/%2e%2e/info',
    '/v1.47/%252e%252e/info',
    '/version#fragment',
    '/version?x=1&x=2',
    '/version\\evil',
    '/version%00',
  ];
  for (const target of malformedTargets) expectDenied(() => request(policy, 'GET', target), /target|path|query|encoding|control|denied/i);

  expectDenied(() => policy.authorize({
    method: 'POST',
    target: `/containers/create?name=${CONTAINER_NAME}`,
    headers: { 'content-length': String(createBody().length) },
    rawHeaders: ['Content-Length', String(createBody().length), 'Content-Length', String(createBody().length)],
    body: createBody(),
  }), /duplicate/i);
  expectDenied(() => policy.authorize({
    method: 'POST',
    target: `/containers/create?name=${CONTAINER_NAME}`,
    headers: { 'content-length': String(createBody().length), 'transfer-encoding': 'chunked' },
    rawHeaders: ['Content-Length', String(createBody().length), 'Transfer-Encoding', 'chunked'],
    body: createBody(),
  }), /framing|length|transfer/i);
  expectDenied(() => request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, Buffer.from('{broken'), {
    'content-type': 'application/json',
  }), /json/i);
  expectDenied(() => request(policy, 'GET', '/version', Buffer.alloc(0), {
    authorization: 'Bearer must-not-cross-the-proxy',
  }), /header.*not allowed/i);
});

test('enforces independent header, query, JSON-body, and tar-body limits', () => {
  expectDenied(() => request(new DockerProxyPolicy(policyOptions({ maxHeaderBytes: 64 })), 'GET', '/version', Buffer.alloc(0), {
    'user-agent': 'x'.repeat(128),
  }), /header.*large/i);
  expectDenied(() => request(new DockerProxyPolicy(policyOptions({ maxQueryBytes: 16 })), 'GET', `/version?value=${'x'.repeat(32)}`), /query.*large/i);
  expectDenied(() => request(
    new DockerProxyPolicy(policyOptions({ maxJsonBodyBytes: 64 })),
    'POST',
    `/containers/create?name=${CONTAINER_NAME}`,
    createBody(),
    { 'content-type': 'application/json' }
  ), /body.*large/i);

  const tarPolicy = new DockerProxyPolicy(policyOptions({ maxArchiveBodyBytes: 8 }));
  bindContainer(tarPolicy);
  expectDenied(() => request(
    tarPolicy,
    'PUT',
    `/containers/${CONTAINER_ID}/archive?path=%2Fworkspace`,
    Buffer.alloc(9),
    { 'content-type': 'application/x-tar' }
  ), /body.*large/i);
});

test('accepts the canonical no-new-privileges spellings but no additional security option', () => {
  for (const securityOption of ['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true']) {
    const policy = new DockerProxyPolicy(policyOptions());
    const host = JSON.parse(createBody()).HostConfig;
    assert.equal(request(
      policy,
      'POST',
      `/containers/create?name=${CONTAINER_NAME}`,
      createBody({ HostConfig: { ...host, SecurityOpt: [securityOption] } }),
      { 'content-type': 'application/json' }
    ).kind, 'container-create');
  }
  const policy = new DockerProxyPolicy(policyOptions());
  const host = JSON.parse(createBody()).HostConfig;
  expectDenied(() => request(
    policy,
    'POST',
    `/containers/create?name=${CONTAINER_NAME}`,
    createBody({ HostConfig: { ...host, SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] } }),
    { 'content-type': 'application/json' }
  ), /security/i);
});

test('fails closed on malformed or conflicting upstream ID responses', () => {
  const policy = new DockerProxyPolicy(policyOptions());
  const decision = request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, createBody(), {
    'content-type': 'application/json',
  });
  expectDenied(() => policy.observeResponse(decision, {
    statusCode: 201,
    headers: {},
    body: Buffer.from('{"Id":"short"}'),
  }), /container id/i);

  policy.observeResponse(decision, {
    statusCode: 201,
    headers: {},
    body: Buffer.from(JSON.stringify({ Id: CONTAINER_ID })),
  });
  expectDenied(() => policy.observeResponse(decision, {
    statusCode: 201,
    headers: {},
    body: Buffer.from(JSON.stringify({ Id: 'd'.repeat(64) })),
  }), /conflicting|already bound/i);
  expectDenied(() => request(policy, 'POST', `/containers/create?name=${CONTAINER_NAME}`, createBody(), {
    'content-type': 'application/json',
  }), /already bound/i);
});

test('the hijack seam forwards pre-read bytes and establishes a bidirectional raw relay', () => {
  const calls = [];
  const downstreamSocket = {
    write(value) { calls.push(['downstream-write', Buffer.from(value).toString('latin1')]); },
    pipe(destination) { calls.push(['downstream-pipe', destination]); return destination; },
    destroy(error) { calls.push(['downstream-destroy', error]); },
  };
  const upstreamSocket = {
    write(value) { calls.push(['upstream-write', Buffer.from(value).toString('utf8')]); },
    pipe(destination) { calls.push(['upstream-pipe', destination]); return destination; },
    destroy(error) { calls.push(['upstream-destroy', error]); },
  };
  relayHijackedTransport({
    downstreamSocket,
    upstreamSocket,
    upstreamResponse: { httpVersion: '1.1', statusCode: 101, statusMessage: 'UPGRADED', rawHeaders: ['Upgrade', 'tcp', 'Connection', 'Upgrade'] },
    upstreamHead: Buffer.from('server-head'),
    downstreamHead: Buffer.from('client-head'),
  });
  assert.match(calls[0][1], /^HTTP\/1\.1 101 UPGRADED\r\n/);
  assert.deepEqual(calls.slice(1, 3).map(([kind, value]) => [kind, value]), [
    ['downstream-write', 'server-head'],
    ['upstream-write', 'client-head'],
  ]);
  assert.ok(calls.some(([kind, value]) => kind === 'downstream-pipe' && value === upstreamSocket));
  assert.ok(calls.some(([kind, value]) => kind === 'upstream-pipe' && value === downstreamSocket));
});

test('Unix-socket proxy forwards normalized requests and re-frames chunked tar bodies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-policy-proxy-'));
  const upstreamPath = path.join(root, 'upstream.sock');
  const proxyPath = path.join(root, 'proxy.sock');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.method === 'HEAD' ? 200 : 200, { 'content-type': 'text/plain' });
      res.end(req.method === 'HEAD' ? undefined : 'ok');
    });
  });
  await new Promise((resolve, reject) => upstream.listen(upstreamPath, (error) => error ? reject(error) : resolve()));
  const proxy = createDockerPolicyProxy({
    listenSocketPath: proxyPath,
    upstreamSocketPath: upstreamPath,
    policy: policyOptions(),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: proxyPath,
      method: 'HEAD',
      path: '/v1.47/_ping',
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  await new Promise((resolve) => response.resume().on('end', resolve));
  assert.equal(response.statusCode, 200);
  assert.equal(seen[0].url, '/_ping');

  const policy = proxy.policy;
  bindContainer(policy);
  const tar = Buffer.from('tar-body-through-chunked-client');
  const tarResponse = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: proxyPath,
      method: 'PUT',
      path: `/v1.47/containers/${CONTAINER_ID}/archive?path=%2Fworkspace`,
      headers: { 'content-type': 'application/x-tar', 'transfer-encoding': 'chunked' },
    }, resolve);
    req.on('error', reject);
    req.write(tar.subarray(0, 7));
    req.end(tar.subarray(7));
  });
  await new Promise((resolve) => tarResponse.resume().on('end', resolve));
  assert.equal(tarResponse.statusCode, 200);
  assert.deepEqual(seen[1].body, tar);
  assert.equal(seen[1].headers['transfer-encoding'], undefined);
  assert.equal(seen[1].headers['content-length'], String(tar.length));

  const secretQueryValue = 'customer-private-path-must-not-survive';
  const deniedResponse = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: proxyPath,
      method: 'POST',
      path: `/auth?opaque=${secretQueryValue}`,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  await new Promise((resolve) => deniedResponse.resume().on('end', resolve));
  assert.equal(deniedResponse.statusCode, 403);

  const productionAudit = proxy.auditSnapshot();
  assert.ok(productionAudit.events.some((event) => event.phase === 'proxy' && event.action === 'listener-started'));
  assert.ok(productionAudit.events.some((event) => event.phase === 'response' && event.kind === 'ping' && event.statusCode === 200));
  assert.ok(productionAudit.events.some((event) => event.phase === 'response' && event.kind === 'archive-put' && event.statusCode === 200));
  assert.ok(productionAudit.events.some((event) => event.phase === 'request' && event.outcome === 'denied'));
  assert.equal(JSON.stringify(productionAudit).includes(secretQueryValue), false);

  await proxy.close();
  const closedAudit = proxy.auditSnapshot();
  assert.ok(closedAudit.events.some((event) => event.phase === 'proxy' && event.action === 'listener-closed'));
  assert.notEqual(closedAudit.evidenceHash, productionAudit.evidenceHash);
});

test('container start stays buffered until the privileged live-observation hook succeeds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-policy-start-hook-'));
  const upstreamPath = path.join(root, 'upstream.sock');
  const proxyPath = path.join(root, 'proxy.sock');
  const upstream = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => upstream.listen(
    upstreamPath,
    (error) => error ? reject(error) : resolve(),
  ));
  const policy = new DockerProxyPolicy(policyOptions());
  bindContainer(policy);
  let releaseHook;
  const hookGate = new Promise((resolve) => { releaseHook = resolve; });
  let observed;
  let hookStarted;
  const hookEntered = new Promise((resolve) => { hookStarted = resolve; });
  const proxy = createDockerPolicyProxy({
    listenSocketPath: proxyPath,
    upstreamSocketPath: upstreamPath,
    policy,
    async onContainerStarted(value) {
      observed = value;
      hookStarted();
      await hookGate;
    },
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  let responseObserved = false;
  const responsePromise = new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: proxyPath,
      method: 'POST',
      path: `/containers/${CONTAINER_ID}/start`,
      headers: { 'content-length': '0' },
    }, (response) => {
      responseObserved = true;
      response.resume().once('end', () => resolve(response));
    });
    request.once('error', reject);
    request.end();
  });
  await hookEntered;
  assert.equal(responseObserved, false, 'Harbor must not observe start success before live evidence');
  assert.deepEqual(observed, {
    containerId: CONTAINER_ID,
    containerBindingHash: createHash('sha256')
      .update('engineer-harness/docker-binding/v1\0')
      .update(CONTAINER_ID)
      .digest('hex'),
  });
  releaseHook();
  const response = await responsePromise;
  assert.equal(response.statusCode, 204);
});

test('Unix-socket proxy relays an attached exec upgrade in both directions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-policy-hijack-'));
  const upstreamPath = path.join(root, 'upstream.sock');
  const proxyPath = path.join(root, 'proxy.sock');
  let upstreamStartBody = null;
  const upstream = http.createServer();
  const upstreamSockets = new Set();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (request, socket, initialHead) => {
    const expected = Number(request.headers['content-length']);
    let buffered = initialHead;
    const receive = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < expected) return;
      socket.off('data', receive);
      upstreamStartBody = JSON.parse(buffered.subarray(0, expected).toString('utf8'));
      const extra = buffered.subarray(expected);
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nserver-head|');
      if (extra.length) socket.write(Buffer.concat([Buffer.from('echo:'), extra]));
      socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
    };
    if (buffered.length >= expected) receive(Buffer.alloc(0));
    else request.on('data', receive);
  });
  await new Promise((resolve, reject) => upstream.listen(upstreamPath, (error) => error ? reject(error) : resolve()));

  const policy = new DockerProxyPolicy(policyOptions());
  bindExec(policy);
  const proxy = createDockerPolicyProxy({ listenSocketPath: proxyPath, upstreamSocketPath: upstreamPath, policy });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const startBody = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
  const received = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for Docker exec upgrade relay')), 3_000);
    const request = http.request({
      socketPath: proxyPath,
      method: 'POST',
      path: `/v1.47/exec/${EXEC_ID}/start`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'tcp',
        'content-type': 'application/json',
        'content-length': startBody.length,
      },
    });
    request.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timeout);
        reject(new Error(`expected upgrade, got ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
      });
    });
    request.once('upgrade', (response, socket, head) => {
      assert.equal(response.statusCode, 101);
      let output = head.toString('utf8');
      const finish = () => {
        if (!output.includes('server-head|') || !output.includes('echo:client-frame')) return;
        clearTimeout(timeout);
        socket.destroy();
        resolve(output);
      };
      socket.on('data', (chunk) => {
        output += chunk.toString('utf8');
        finish();
      });
      socket.once('error', reject);
      socket.write('client-frame');
      finish();
    });
    request.end(startBody);
  });
  assert.match(received, /server-head\|/);
  assert.match(received, /echo:client-frame/);
  assert.deepEqual(upstreamStartBody, { Detach: false, Tty: false });
});
