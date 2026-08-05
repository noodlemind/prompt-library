const MIB = 1024 * 1024;

/**
 * Direction-specific archive ceilings.
 *
 * The task-input profile is sized from the larger exact release arm:
 * 6,069 entries, 344,189,652 content bytes, 348,767,744 raw tar bytes,
 * 121,145,501 gzip bytes, a 121,613,752-byte Node executable, and a
 * 1,236,039-byte control manifest. The reviewed ceilings retain 10% or more
 * headroom while keeping expansion materially below a 512 MiB profile. Trial
 * output remains on the original, tighter untrusted extraction profile.
 */
export const TASK_INPUT_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 128 * MIB,
  uncompressedBytes: 384 * MIB,
  contentBytes: 384 * MIB,
  fileBytes: 128 * MIB,
  entries: 8_192,
  controlDocumentBytes: 2 * MIB,
});

export const TRIAL_OUTPUT_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 64 * MIB,
  uncompressedBytes: 96 * MIB,
  contentBytes: 48 * MIB,
  fileBytes: 16 * MIB,
  entries: 4_096,
  controlDocumentBytes: 512 * 1024,
});

export function archiveLimitsForKind(kind) {
  if (kind === 'task-input') return TASK_INPUT_ARCHIVE_LIMITS;
  if (kind === 'trial-output') return TRIAL_OUTPUT_ARCHIVE_LIMITS;
  throw new TypeError('archive kind must be task-input or trial-output');
}
