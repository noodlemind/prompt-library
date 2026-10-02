import fs from 'node:fs';
import path from 'node:path';
import { renderEngineerProfile } from './engineer-profile.mjs';

export function writeEngineerProfile({ host, directory }) {
  const text = `${renderEngineerProfile(host)}\n`;
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
  const filePath = path.join(directory, `engineer-${host}.md`);
  fs.writeFileSync(filePath, text, 'utf8');
  return { path: filePath, bytes: fs.statSync(filePath).size };
}
