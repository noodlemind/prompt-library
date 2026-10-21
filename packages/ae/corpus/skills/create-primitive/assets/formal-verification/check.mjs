import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Copy this file into the product verification directory. It has no AE, npm,
// plugin or network dependency. The reviewed manifest authorizes local helpers;
// invoking it does not approve a project or install any verification tool.
const PIN = Object.freeze({ release: 'v1.7.4', version: '2.19 of 08 August 2024', sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88', minimumJavaMajor: 17 });
const MAX_BYTES = 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value) || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe contained relative path: ${value}`);
  return value;
}

function contained(root, rel) {
  relative(rel);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail(`symbolic link is not a verification input: ${rel}`);
  }
  return current;
}

function readRegular(root, rel, limit = MAX_BYTES) {
  const full = contained(root, rel), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.size > limit) fail(`verification input must be a bounded regular file: ${rel}`);
  const bytes = fs.readFileSync(full);
  if (bytes.length > limit) fail(`verification input exceeds the byte limit: ${rel}`);
  return bytes;
}

function cleanEnv(env) {
  const result = { ...env };
  for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY', 'TLA_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete result[key];
  return result;
}

function execute(command, args, { cwd, env, timeout = 30_000, maxBuffer = 512 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd, env: cleanEnv(env), encoding: 'utf8', shell: false, timeout, maxBuffer, windowsHide: true });
  return { command, args, status: result.status, signal: result.signal, error: result.error ? { code: result.error.code, message: result.error.message } : null, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function metadataGit(workspace) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' });
  const args = ['--no-pager', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-C', workspace];
  const config = execute('git', [...args, 'config', '--includes', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { cwd: workspace, env, timeout: 4000, maxBuffer: 64 * 1024 });
  if (config.status === 129 && /unknown option:\s*--no-lazy-fetch\b/i.test(config.stderr)) fail('Upgrade Git to a version supporting --no-lazy-fetch before running formal verification; safe metadata inspection cannot retry without the no-fetch guard');
  if (config.error || ![0, 1].includes(config.status) || config.status === 1 && config.stdout !== '' || config.status === 0 && !config.stdout.endsWith('\0')) fail('Git filter metadata is unavailable or malformed');
  const drivers = new Set();
  for (const entry of config.stdout ? config.stdout.slice(0, -1).split('\0') : []) {
    const separator = entry.indexOf('\n');
    const match = separator > 0 && entry.slice(0, separator).match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/i);
    if (!match || /[=\r\n\0]/.test(match[1])) fail('Git filter metadata is malformed');
    drivers.add(match[1]);
  }
  for (const driver of drivers) {
    for (const operation of ['clean', 'smudge', 'process']) args.push('-c', `filter.${driver}.${operation}=`);
    args.push('-c', `filter.${driver}.required=false`);
  }
  return { args, env };
}

function prepareArtifactDirectory(requested) {
  const absolute = path.resolve(requested), root = path.parse(absolute).root;
  const rel = path.relative(root, absolute).replaceAll('\\', '/');
  relative(rel);
  let current = root;
  // Reject existing links before recursive mkdir can follow one outside the
  // selected tree. Only a fully validated root is eligible for receipt writes.
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) fail('symbolic link is not an artifact directory');
    if (!stat.isDirectory()) fail('artifact root ancestors must be directories');
  }
  fs.mkdirSync(absolute, { recursive: true });
  contained(root, rel);
  return fs.realpathSync(absolute);
}

function privateArtifactDirectory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ae-formal-evidence-'));
}

export function collectCoverage(workspace, coverage) {
  const root = fs.realpathSync(workspace);
  if (!coverage || !Array.isArray(coverage.sources) || !Array.isArray(coverage.watchRoots) || coverage.sources.length > 256 || coverage.watchRoots.length > 32) fail('coverage requires bounded sources and watchRoots');
  const extensions = coverage.extensions || ['*'];
  if (!Array.isArray(extensions) || !extensions.length || extensions.length > 32 || extensions.some(ext => typeof ext !== 'string' || ext !== '*' && !/^\.[a-z0-9]+$/i.test(ext))) fail('invalid coverage extensions');
  const found = new Set(coverage.sources.map(relative));
  let visited = 0;
  function visit(rel, depth = 0) {
    if (++visited > 4096 || depth > 32) fail('watched source inventory exceeds its finite budget');
    const full = contained(root, rel), stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(`${rel}/${name}`, depth + 1);
    } else if (!stat.isFile()) fail(`watched source is not regular: ${rel}`);
    else if (extensions.includes('*') || extensions.includes(path.extname(rel))) found.add(rel);
  }
  for (const rel of coverage.watchRoots) visit(relative(rel));
  const files = [...found].sort().map(rel => ({ path: rel, sha256: hash(readRegular(root, rel)) }));
  if (!files.length) fail('declared source coverage is empty');
  const metadata = metadataGit(root);
  const head = execute('git', [...metadata.args, 'rev-parse', 'HEAD'], { cwd: root, env: metadata.env });
  if (head.error || head.status !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) fail('current Git commit is unavailable');
  const status = execute('git', [...metadata.args, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'], { cwd: root, env: metadata.env });
  if (status.error || status.status !== 0) fail('working-tree status is unavailable');
  return { commit: head.stdout.trim(), dirty: Boolean(status.stdout.trim()), sourceKind: 'working-tree-bytes', files, digest: hash(JSON.stringify(files)) };
}

export function classifyTlc(execution, expected, property = null) {
  const frames = [...String(execution.stdout || '').matchAll(/@!@!@STARTMSG (\d+):(\d+) @!@!@\r?\n([\s\S]*?)@!@!@ENDMSG \1 @!@!@/g)].map(match => ({ id: +match[1], severity: +match[2], text: match[3].trim() }));
  const ids = frames.map(frame => frame.id);
  const errors = frames.filter(frame => frame.severity === 1 || frame.severity === 2);
  const stats = frames.find(frame => frame.id === 2199)?.text.match(/([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/);
  const states = stats ? { generated: +stats[1].replaceAll(',', ''), distinct: +stats[2].replaceAll(',', ''), remaining: +stats[3].replaceAll(',', '') } : null;
  const complete = ids.includes(2186) && !execution.error && !execution.signal;
  const trace = ids.some(id => [2216, 2217, 2218].includes(id));
  let pass = false;
  if (expected === 'pass') pass = complete && execution.status === 0 && ids.includes(2193) && !errors.length && states?.distinct > 0 && states.remaining === 0;
  if (expected === 'safety-violation') pass = complete && execution.status === 12 && trace && errors.some(frame => [2107, 2110].includes(frame.id) && frame.text === `Invariant ${property} is violated.`) && errors.every(frame => [2107, 2110, 2121].includes(frame.id));
  if (expected === 'liveness-violation') pass = complete && execution.status === 13 && trace && errors.some(frame => frame.id === 2116) && errors.every(frame => [2116, 2121, 2264].includes(frame.id));
  return { pass: Boolean(pass), expected, property, complete, states, trace, messageIds: ids, errors: errors.map(({ id, text }) => ({ id, text })) };
}

export function validateConfiguration(text) {
  // The starter intentionally accepts one small grammar, not general TLC cfg.
  // Whitelisting prevents whitespace/plural spellings from hiding reductions.
  const lines = text.split(/\r?\n/).map(line => line.replace(/\\\*.*$/, '').trim()).filter(Boolean);
  if (lines.length !== 3 || lines.filter(line => line === 'SPECIFICATION Spec').length !== 1 ||
      lines.filter(line => /^INVARIANTS? [A-Za-z][A-Za-z0-9_]*(?: [A-Za-z][A-Za-z0-9_]*)*$/.test(line)).length !== 1 ||
      lines.filter(line => /^PROPERT(?:Y|IES) [A-Za-z][A-Za-z0-9_]*(?: [A-Za-z][A-Za-z0-9_]*)*$/.test(line)).length !== 1) fail('starter configuration requires only Spec, one invariant list and one temporal property list; reductions and extra directives are unsupported');
  return { invariants: lines.find(line => /^INVARIANT/.test(line)).split(' ').slice(1), properties: lines.find(line => /^PROPERT/.test(line)).split(' ').slice(1) };
}

function validateManifest(manifest) {
  const keys = ['schema', 'id', 'property', 'intentSources', 'limitations', 'tool', 'models', 'coverage', 'conformance', 'lastMaintenance'];
  if (!manifest || manifest.schema !== 1 || Object.keys(manifest).some(key => !keys.includes(key)) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id || '')) fail('invalid formal verification manifest');
  if (typeof manifest.property !== 'string' || !manifest.property.trim() || !Array.isArray(manifest.intentSources) || !manifest.intentSources.length || !Array.isArray(manifest.limitations) || !manifest.limitations.length) fail('property, accepted intent sources and explicit limitations are required');
  if (canonical(manifest.tool) !== canonical(PIN)) fail('TLC tool identity must match the reviewed v1.7.4 pin');
  if (!Array.isArray(manifest.models) || manifest.models.length < 3 || manifest.models.length > 8) fail('declare a positive model and safety/liveness negative controls');
  for (const model of manifest.models) {
    if (Object.keys(model).some(key => !['module', 'config', 'expect', 'property'].includes(key)) || !/^[A-Za-z][A-Za-z0-9_]*\.tla$/.test(model.module || '') || !/^[A-Za-z][A-Za-z0-9_]*\.cfg$/.test(model.config || '') || !['pass', 'safety-violation', 'liveness-violation'].includes(model.expect) || model.expect !== 'pass' && !/^[A-Za-z][A-Za-z0-9_]*$/.test(model.property || '')) fail('invalid fixed model/config declaration or missing intended negative property');
  }
  for (const expectation of ['pass', 'safety-violation', 'liveness-violation']) if (!manifest.models.some(model => model.expect === expectation)) fail(`missing ${expectation} model`);
  for (const rel of manifest.intentSources) relative(rel);
  for (const command of [manifest.conformance?.command, manifest.conformance?.negativeControl]) {
    if (!Array.isArray(command) || command.length < 2 || command.length > 8 || command[0] !== 'node' || !command[1].endsWith('.mjs') || command.slice(1).some(arg => typeof arg !== 'string' || !arg || /[\x00-\x1f\x7f]/.test(arg))) fail('conformance requires explicit reviewed node script argv');
    relative(command[1]);
  }
  const conformance = manifest.conformance;
  if (typeof conformance.positiveFeature !== 'string' || !conformance.positiveFeature || typeof conformance.negativeFeature !== 'string' || !conformance.negativeFeature || conformance.positiveFeature === conformance.negativeFeature) fail('distinct expected positive and negative receipt features are required');
  for (const key of ['invariantIds', 'negativeInvariantIds']) if (!Array.isArray(conformance[key]) || !conformance[key].length || conformance[key].length > 16 || conformance[key].some(id => typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id))) fail('explicit conformance invariant IDs are required');
}

function verificationBindings(root, manifestRel, manifest) {
  const modelDir = path.posix.dirname(manifestRel);
  const rel = name => modelDir === '.' ? name : `${modelDir}/${name}`;
  const paths = new Set([...manifest.models.flatMap(model => [rel(model.module), rel(model.config)]), ...manifest.intentSources, manifest.conformance.command[1], manifest.conformance.negativeControl[1]]);
  const files = [...paths].sort().map(file => ({ path: file, sha256: hash(readRegular(root, file)) }));
  files.push({ path: '<copied-runner>', sha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))) });
  const { lastMaintenance, coverage, ...policy } = manifest;
  const { lastSync, ...coveragePolicy } = coverage;
  return { files, digest: hash(canonical({ files, policy: { ...policy, coverage: coveragePolicy } })), modelDir, rel };
}

function writeReceipt(dir, receipt) {
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('formal receipt exceeds the supported artifact size');
  fs.writeFileSync(path.join(dir, 'formal-verification.json'), bytes, { flag: 'wx' });
  return hash(bytes);
}

function replaceOwnedReceipt(dir, receipt, previousHash) {
  const full = path.join(dir, 'formal-verification.json');
  if (fs.lstatSync(full).isSymbolicLink() || hash(fs.readFileSync(full)) !== previousHash) fail('receipt was replaced by another writer');
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('formal receipt exceeds the supported artifact size');
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, full); }
  finally { fs.rmSync(temp, { force: true }); }
  return hash(bytes);
}

export async function runFormalVerification({ workspace = process.cwd(), manifestPath, maintain = false, rationale = '', env = process.env } = {}) {
  const receipt = { schema: 1, feature: 'formal-verification', passed: false, status: 'blocked', semanticCompleteness: 'unverified', assurance: 'finite-model-and-observed-implementation-correspondence', models: [], conformance: [] };
  let ownedLock = null, root, artifactDir, receiptHash = null;
  try {
    root = fs.realpathSync(workspace);
    artifactDir = env.HARNESS_CHECK_ARTIFACT_DIR ? prepareArtifactDirectory(env.HARNESS_CHECK_ARTIFACT_DIR) : privateArtifactDirectory();
    receipt.evidencePath = path.join(artifactDir, 'formal-verification.json');
    if (fs.existsSync(receipt.evidencePath)) fail('formal-verification.json already exists; use a fresh invocation artifact directory');
    const manifestRel = path.relative(root, path.resolve(root, manifestPath || '')).replaceAll('\\', '/');
    const original = readRegular(root, relative(manifestRel));
    const manifest = JSON.parse(original.toString('utf8'));
    validateManifest(manifest);
    if (maintain && (!rationale.trim() || rationale.length > 4096)) fail('--maintain requires a bounded --rationale describing the reviewed code/model correspondence decision');
    if (maintain) {
      const lock = path.join(fs.realpathSync(os.tmpdir()), `ae-formal-maintain-${hash(contained(root, manifestRel))}.lock`);
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      ownedLock = lock;
    }
    const source = collectCoverage(root, manifest.coverage);
    const bindings = verificationBindings(root, manifestRel, manifest);
    const previous = manifest.coverage.lastSync;
    const current = previous?.digest === source.digest && previous?.verificationDigest === bindings.digest;
    receipt.id = manifest.id;
    receipt.source = source;
    receipt.verificationBindings = bindings.files;
    receipt.sync = { current, previous: previous || null, candidate: { commit: source.commit, dirty: source.dirty, sourceKind: source.sourceKind, digest: source.digest, verificationDigest: bindings.digest }, maintained: false };
    if (!current && !maintain) fail('source, watched file inventory or verification changed; review drift and run --maintain --rationale before claiming current proof');

    const jar = env.AE_TLC_JAR;
    if (!jar || !path.isAbsolute(jar)) fail('AE_TLC_JAR must name an explicitly installed absolute TLC JAR path');
    const jarStat = fs.lstatSync(jar);
    if (!jarStat.isFile() || jarStat.isSymbolicLink() || jarStat.size > 64 * MAX_BYTES || hash(fs.readFileSync(jar)) !== PIN.sha256) fail('TLC JAR SHA-256 does not match the reviewed official release');
    const java = env.AE_TLC_JAVA || 'java';
    if (env.AE_TLC_JAVA && !path.isAbsolute(java)) fail('AE_TLC_JAVA must be an absolute executable path');
    const javaVersion = execute(java, ['-version'], { cwd: root, env });
    const javaMajor = /version "(\d+)/.exec(javaVersion.stderr + javaVersion.stdout)?.[1];
    if (javaVersion.error || javaVersion.status !== 0 || !javaMajor || +javaMajor < PIN.minimumJavaMajor) fail('Java 17 or newer is unavailable');
    const toolVersion = execute(java, ['-cp', jar, 'tlc2.TLC', '-help'], { cwd: root, env });
    // This pinned release returns 1 for its help command; that is not a model run.
    if (toolVersion.error || toolVersion.signal || toolVersion.status !== 1 || !(toolVersion.stdout + toolVersion.stderr).includes(`Version ${PIN.version}`)) fail('TLC version output does not match the pinned tool');
    receipt.tool = { ...PIN, jar, javaVersion: (javaVersion.stderr + javaVersion.stdout).trim() };

    const sandbox = fs.mkdtempSync(path.join(artifactDir, 'run-'));
    for (const name of new Set(manifest.models.flatMap(model => [model.module, model.config]))) {
      const bytes = readRegular(root, bindings.rel(name), 64 * 1024);
      if (name.endsWith('.cfg')) validateConfiguration(bytes.toString('utf8'));
      fs.writeFileSync(path.join(sandbox, name), bytes, { flag: 'wx' });
    }
    for (const model of manifest.models) {
      const configured = validateConfiguration(fs.readFileSync(path.join(sandbox, model.config), 'utf8'));
      if (model.expect === 'safety-violation' && !configured.invariants.includes(model.property) || model.expect === 'liveness-violation' && (configured.properties.length !== 1 || configured.properties[0] !== model.property)) fail('negative control must name its configured intended property');
      const args = ['-Xmx512m', '-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-tool', '-workers', '1', '-fp', '0', '-seed', '0', '-config', model.config, '-metadir', path.join(sandbox, `${path.basename(model.module, '.tla')}-states`), model.module];
      const execution = execute(java, args, { cwd: sandbox, env });
      const outcome = classifyTlc(execution, model.expect, model.property || null);
      receipt.models.push({ module: model.module, ...outcome, execution });
      if (!outcome.pass) { receipt.status = execution.error || execution.signal ? 'blocked' : 'failed'; fail(`TLC ${model.module} did not produce its required ${model.expect} result`); }
    }
    for (const [kind, command] of [['positive', manifest.conformance.command], ['negative', manifest.conformance.negativeControl]]) {
      readRegular(root, command[1]);
      const helperDir = path.join(sandbox, `implementation-${kind}`);
      fs.mkdirSync(helperDir);
      const execution = execute(process.execPath, [contained(root, command[1]), ...command.slice(2)], { cwd: root, env: { ...env, HARNESS_CHECK_ARTIFACT_DIR: helperDir }, timeout: 60_000 });
      let observed = null;
      try { observed = JSON.parse(execution.stdout); } catch { /* malformed output never constitutes code correspondence */ }
      const expectedFeature = kind === 'positive' ? manifest.conformance.positiveFeature : manifest.conformance.negativeFeature;
      const requiredIds = kind === 'positive' ? manifest.conformance.invariantIds : manifest.conformance.negativeInvariantIds;
      const checkedIds = kind === 'positive' ? observed?.invariantIds : observed?.checkedInvariantIds;
      const validIds = Array.isArray(checkedIds) && checkedIds.length > 0 && checkedIds.length <= 16 && checkedIds.every(id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id));
      const pass = !execution.error && !execution.signal && execution.status === 0 && observed?.schema === 1 && observed.passed === true && observed.feature === expectedFeature && Array.isArray(observed.steps) && observed.steps.length > 0 && validIds && requiredIds.every(id => checkedIds.includes(id)) && (kind === 'negative' ? observed.detected === true : observed.detected !== true);
      receipt.conformance.push({ kind, pass, execution, observed });
      if (!pass) { receipt.status = execution.error || execution.signal ? 'blocked' : 'failed'; fail(`actual implementation ${kind} control did not establish its required result`); }
    }
    const after = collectCoverage(root, manifest.coverage), afterBindings = verificationBindings(root, manifestRel, manifest);
    if (after.commit !== source.commit || after.digest !== source.digest || afterBindings.digest !== bindings.digest || !readRegular(root, manifestRel).equals(original)) fail('source, model, helper, intent or manifest changed while checking; evidence is not current');
    receipt.passed = true;
    receipt.status = 'passed';
    if (maintain) {
      manifest.coverage.lastSync = { commit: source.commit, dirty: source.dirty, sourceKind: source.sourceKind, digest: source.digest, verificationDigest: bindings.digest, files: source.files };
      manifest.lastMaintenance = { rationale, previous: previous ? { commit: previous.commit, digest: previous.digest, verificationDigest: previous.verificationDigest } : null, candidate: receipt.sync.candidate, semanticCompleteness: 'unverified' };
      const next = JSON.stringify(manifest, null, 2) + '\n';
      // Evidence must publish successfully before advancing synchronization.
      receiptHash = writeReceipt(artifactDir, receipt);
      const temp = `${contained(root, manifestRel)}.${crypto.randomUUID()}.tmp`;
      let advanced = false;
      try {
        fs.writeFileSync(temp, next, { flag: 'wx' });
        if (!readRegular(root, manifestRel).equals(original)) fail('manifest changed before synchronization publication');
        fs.renameSync(temp, path.join(root, manifestRel));
        advanced = true;
        receipt.sync.maintained = true;
        receiptHash = replaceOwnedReceipt(artifactDir, receipt, receiptHash);
      } catch (error) {
        if (advanced) {
          if (readRegular(root, manifestRel).toString('utf8') !== next) fail(`synchronization publication interrupted and another writer changed the manifest: ${error.message}`);
          fs.writeFileSync(temp, original, { flag: 'wx' });
          fs.renameSync(temp, path.join(root, manifestRel));
          receipt.sync.maintained = false;
        }
        throw error;
      } finally { fs.rmSync(temp, { force: true }); }
    }
  } catch (error) {
    receipt.passed = false;
    if (receipt.status === 'passed') receipt.status = 'blocked';
    receipt.reason = error.message;
  } finally {
    if (ownedLock) fs.rmSync(ownedLock, { force: true });
  }
  if (!artifactDir) artifactDir = privateArtifactDirectory();
  receipt.evidencePath ||= path.join(artifactDir, 'formal-verification.json');
  try { if (receiptHash) { if (!receipt.passed) replaceOwnedReceipt(artifactDir, receipt, receiptHash); } else writeReceipt(artifactDir, receipt); }
  catch (error) { receipt.passed = false; receipt.status = 'blocked'; receipt.reason = `receipt publication failed: ${error.message}`; }
  return receipt;
}

export async function main(argv = process.argv.slice(2), defaults = {}) {
  const options = { ...defaults };
  try {
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token === '--maintain') options.maintain = true;
      else if (['--manifest', '--rationale', '--workspace'].includes(token) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[{ '--manifest': 'manifestPath', '--rationale': 'rationale', '--workspace': 'workspace' }[token]] = argv[++i];
      else fail(`unsupported or missing formal-check argument: ${token}`);
    }
    const receipt = await runFormalVerification(options);
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.passed ? 0 : 1;
    return receipt;
  } catch (error) {
    console.log(JSON.stringify({ schema: 1, feature: 'formal-verification', passed: false, status: 'blocked', reason: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
