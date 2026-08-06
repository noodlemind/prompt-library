import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findCredentialMarkerRanges,
  MAX_CREDENTIAL_MARKER_RANGES,
} from '../runtime/credential-material.mjs';
import {
  buildDeterministicUstar,
} from '../runtime/deterministic-ustar.mjs';
import {
  verifyDeterministicUstarCredentialRanges,
} from '../runtime/deterministic-ustar-verifier.mjs';

const APPROVED_PATH = 'usr/local/bin/docker';
const SECOND_APPROVED_PATH = 'usr/local/bin/dockerd';
const FALSE_POSITIVE = Buffer.from('binary-prefix\0Bearer compiledFalsePositive123\0binary-suffix');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t, {
  relative = APPROVED_PATH,
  content = FALSE_POSITIVE,
  executable = true,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ustar-verifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const target = path.join(source, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, executable ? 0o755 : 0o644);
  const input = { kind: 'runtime', root: source };
  if (findCredentialMarkerRanges(content).length > 0 && executable) {
    input.credentialScanExemptions = [{ path: relative, sha256: sha256(content) }];
  }
  const built = buildDeterministicUstar(input);
  const archivePath = path.join(directory, 'runtime.tar');
  fs.writeFileSync(archivePath, built.bytes);
  return { archivePath, bytes: built.bytes, content, relative };
}

async function verifyArchive(archivePath, allowedExecutableDigests, declaredByteLength = null) {
  const bytes = fs.readFileSync(archivePath);
  const credentialRanges = findCredentialMarkerRanges(bytes);
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    return await verifyDeterministicUstarCredentialRanges({
      handle,
      byteLength: declaredByteLength ?? bytes.length,
      credentialRanges,
      allowedExecutableDigests,
    });
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

function rewriteFirstHeaderMode(bytes, mode) {
  const header = bytes.subarray(0, 512);
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  rewriteHeaderChecksum(header);
}

function rewriteHeaderChecksum(header) {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

test('keeps ordinary marker inventories at their fail-closed bound', () => {
  const marker = `AKIA${'A'.repeat(16)}\n`;
  assert.equal(MAX_CREDENTIAL_MARKER_RANGES, 256);
  assert.equal(
    findCredentialMarkerRanges(Buffer.from(marker.repeat(MAX_CREDENTIAL_MARKER_RANGES))).length,
    MAX_CREDENTIAL_MARKER_RANGES,
  );
  assert.throws(
    () => findCredentialMarkerRanges(Buffer.from(marker.repeat(MAX_CREDENTIAL_MARKER_RANGES + 1))),
    /count|bound/i,
  );
});

test('accepts credential-like bytes only inside an exact executable path and digest', async (t) => {
  const input = fixture(t);
  const result = await verifyArchive(input.archivePath, {
    [APPROVED_PATH]: sha256(input.content),
  });
  assert.deepEqual(result, {
    credentialRangeCount: 1,
    attestedEntryCount: 1,
    entries: [{
      path: APPROVED_PATH,
      type: 'file',
      mode: 0o555,
      byteLength: input.content.length,
      sha256: sha256(input.content),
    }],
  });

  const second = fixture(t, {
    relative: SECOND_APPROVED_PATH,
    content: Buffer.from('dockerd-prefix\0Bearer secondCompiledFalsePositive456\0dockerd-suffix'),
  });
  const secondResult = await verifyArchive(second.archivePath, {
    [SECOND_APPROVED_PATH]: sha256(second.content),
  });
  assert.deepEqual(secondResult, {
    credentialRangeCount: 1,
    attestedEntryCount: 1,
    entries: [{
      path: SECOND_APPROVED_PATH,
      type: 'file',
      mode: 0o555,
      byteLength: second.content.length,
      sha256: sha256(second.content),
    }],
  });
});

test('rejects markers outside an approved entry and approved entries with wrong identity', async (t) => {
  const unapproved = fixture(t, { relative: 'opt/app/tool' });
  await assert.rejects(
    verifyArchive(unapproved.archivePath, { [APPROVED_PATH]: sha256(unapproved.content) }),
    /credential|attest|entry/i,
  );

  const wrongDigest = fixture(t);
  await assert.rejects(
    verifyArchive(wrongDigest.archivePath, { [APPROVED_PATH]: '0'.repeat(64) }),
    /digest|attest|credential/i,
  );

  const drifted = fixture(t);
  const driftedBytes = fs.readFileSync(drifted.archivePath);
  const contentOffset = driftedBytes.indexOf(drifted.content, 512);
  assert.ok(contentOffset >= 512);
  driftedBytes[contentOffset + drifted.content.length - 1] ^= 0x01;
  fs.writeFileSync(drifted.archivePath, driftedBytes);
  await assert.rejects(
    verifyArchive(drifted.archivePath, { [APPROVED_PATH]: sha256(drifted.content) }),
    /digest|attest|credential/i,
  );
});

test('rejects a parent-traversal entry even when another entry has an exact attestation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ustar-verifier-traversal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const approved = path.join(source, ...APPROVED_PATH.split('/'));
  fs.mkdirSync(path.dirname(approved), { recursive: true });
  fs.writeFileSync(path.join(source, 'safe'), 'ordinary');
  fs.writeFileSync(approved, FALSE_POSITIVE);
  fs.chmodSync(approved, 0o755);
  const built = buildDeterministicUstar({
    kind: 'runtime',
    root: source,
    credentialScanExemptions: [{
      path: APPROVED_PATH,
      sha256: sha256(FALSE_POSITIVE),
    }],
  });
  const bytes = Buffer.from(built.bytes);
  const firstHeader = bytes.subarray(0, 512);
  firstHeader.fill(0, 0, 100);
  firstHeader.write('../x', 0, 4, 'ascii');
  rewriteHeaderChecksum(firstHeader);
  const archivePath = path.join(directory, 'runtime.tar');
  fs.writeFileSync(archivePath, bytes);

  await assert.rejects(
    verifyArchive(archivePath, { [APPROVED_PATH]: sha256(FALSE_POSITIVE) }),
    /path|relative|traversal|header/i,
  );
});

test('rejects sensitive filenames in any path component without a credential marker', async (t) => {
  for (const sensitivePath of ['credentials.json', '.env/payload']) {
    const input = fixture(t, {
      relative: 'ordinary.json',
      content: Buffer.from('{}'),
      executable: false,
    });
    const bytes = fs.readFileSync(input.archivePath);
    const header = bytes.subarray(0, 512);
    header.fill(0, 0, 100);
    header.write(sensitivePath, 0, 'ascii');
    rewriteHeaderChecksum(header);
    fs.writeFileSync(input.archivePath, bytes);

    await assert.rejects(
      verifyArchive(input.archivePath, { [APPROVED_PATH]: sha256(FALSE_POSITIVE) }),
      /path|credential|sensitive|header/i,
    );
  }
});

test('rejects markers in non-executable entries, headers, or malformed archives', async (t) => {
  const nonExecutableContent = Buffer.from('Bearer readonlyCredentialMarker123');
  const nonExecutable = fixture(t, {
    content: Buffer.alloc(nonExecutableContent.length, 0x78),
    executable: false,
  });
  const nonExecutableBytes = fs.readFileSync(nonExecutable.archivePath);
  const dataOffset = nonExecutableBytes.indexOf(Buffer.alloc(nonExecutableContent.length, 0x78), 512);
  assert.ok(dataOffset >= 512);
  nonExecutableContent.copy(nonExecutableBytes, dataOffset);
  fs.writeFileSync(nonExecutable.archivePath, nonExecutableBytes);
  await assert.rejects(
    verifyArchive(nonExecutable.archivePath, {
      [APPROVED_PATH]: sha256(nonExecutableContent),
    }),
    /mode|executable|credential|attest/i,
  );

  const permissiveMode = fixture(t);
  const permissiveModeBytes = fs.readFileSync(permissiveMode.archivePath);
  rewriteFirstHeaderMode(permissiveModeBytes, 0o755);
  fs.writeFileSync(permissiveMode.archivePath, permissiveModeBytes);
  await assert.rejects(
    verifyArchive(permissiveMode.archivePath, {
      [APPROVED_PATH]: sha256(permissiveMode.content),
    }),
    /mode|bound|credential|attest/i,
  );

  const headerMarker = fixture(t, {
    relative: 'sk-proj-abcdefghijklmnop',
    content: Buffer.from('ordinary content'),
  });
  await assert.rejects(
    verifyArchive(headerMarker.archivePath, { [APPROVED_PATH]: sha256(headerMarker.content) }),
    /header|credential|attest|entry/i,
  );

  const malformed = fixture(t);
  const malformedBytes = fs.readFileSync(malformed.archivePath);
  malformedBytes[0] ^= 0x01;
  fs.writeFileSync(malformed.archivePath, malformedBytes);
  await assert.rejects(
    verifyArchive(malformed.archivePath, { [APPROVED_PATH]: sha256(malformed.content) }),
    /header|checksum|archive|credential/i,
  );

  const trailing = fixture(t);
  fs.appendFileSync(trailing.archivePath, Buffer.alloc(512));
  await assert.rejects(
    verifyArchive(trailing.archivePath, { [APPROVED_PATH]: sha256(trailing.content) }),
    /trailing|archive|credential/i,
  );

  const hiddenTrailing = fixture(t);
  const originalLength = fs.statSync(hiddenTrailing.archivePath).size;
  fs.appendFileSync(hiddenTrailing.archivePath, Buffer.alloc(512));
  await assert.rejects(
    verifyArchive(
      hiddenTrailing.archivePath,
      { [APPROVED_PATH]: sha256(hiddenTrailing.content) },
      originalLength,
    ),
    /length|bound|archive|file/i,
  );

  const nonZeroPadding = fixture(t);
  const nonZeroPaddingBytes = fs.readFileSync(nonZeroPadding.archivePath);
  const paddingStart = 512 + nonZeroPadding.content.length;
  assert.notEqual(paddingStart % 512, 0);
  nonZeroPaddingBytes[paddingStart] = 0x01;
  fs.writeFileSync(nonZeroPadding.archivePath, nonZeroPaddingBytes);
  await assert.rejects(
    verifyArchive(nonZeroPadding.archivePath, {
      [APPROVED_PATH]: sha256(nonZeroPadding.content),
    }),
    /padding|archive|credential/i,
  );

  const missingEnd = fixture(t);
  const missingEndBytes = fs.readFileSync(missingEnd.archivePath);
  fs.writeFileSync(missingEnd.archivePath, missingEndBytes.subarray(0, -512));
  await assert.rejects(
    verifyArchive(missingEnd.archivePath, { [APPROVED_PATH]: sha256(missingEnd.content) }),
    /end|trailing|archive|credential/i,
  );
});
