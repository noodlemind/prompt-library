import fs from 'node:fs';
import path from 'node:path';
import { renderEngineerProfile } from './engineer-profile.mjs';

export function writeEngineerProfile({ host, directory }) {
  const text = `${renderEngineerProfile(host)}\n`;
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
  const filePath = path.join(directory, `engineer-${host}.md`);
  let existing;
  try {
    existing = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to write symlink: ${filePath}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
  );
  try {
    fs.writeFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return { path: filePath, bytes: fs.statSync(filePath).size };
}
