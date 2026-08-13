import { getAssetsRoot } from './assets.mjs';
import { collectAllAssetFiles } from './sync.mjs';
import { readLock } from './lock.mjs';
import { placedFiles } from './bundle-sync.mjs';
import { localPrimitiveStatus } from './local-primitives.mjs';

/** Files the package ships. Empty when assets are unavailable — listing then
 * treats everything under the home as local rather than crashing a picker. */
export function shippedAssetFiles() {
  try {
    return new Set(collectAllAssetFiles(getAssetsRoot()));
  } catch {
    return new Set();
  }
}

export function primitiveOrigins(copilotHome) {
  return {
    shippedFiles: shippedAssetFiles(),
    lockFiles: new Set([...(readLock(copilotHome)?.files || []), ...placedFiles(copilotHome)]),
  };
}

export function listLocalPrimitives(copilotHome) {
  const { shippedFiles, lockFiles } = primitiveOrigins(copilotHome);
  return localPrimitiveStatus({ copilotHome, shippedFiles, lockFiles });
}
