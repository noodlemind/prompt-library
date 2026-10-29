import { parentPort, workerData } from 'node:worker_threads';
import { rasterizeSvg } from './raster.mjs';

const MAX_PNG_BYTES = 8 * 1024 * 1024;

rasterizeSvg(workerData.svg, workerData.scale).then(png => {
  if (png.length > MAX_PNG_BYTES) parentPort.postMessage({ error: 'png exceeds 8 MiB; lower --scale' });
  else parentPort.postMessage({ png });
}, error => parentPort.postMessage({ error: String(error?.message || error).slice(0, 500) }));
