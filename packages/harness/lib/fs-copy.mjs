import fs from 'node:fs';

export function copyDirectorySync(source, target, options = {}) {
  // Node 22's native traversal and overwrite paths mishandle accented Windows names.
  const filter = (from, to) => {
    const src = fs.lstatSync(from, { bigint: true });
    const dest = fs.lstatSync(to, { bigint: true, throwIfNoEntry: false });
    if ((options.force ?? true) && src.isFile() && dest) {
      if (src.dev === dest.dev && src.ino === dest.ino) {
        throw Object.assign(new Error('cannot copy a file onto itself'), { code: 'EINVAL' });
      }
      if (!dest.isFile() && !dest.isSymbolicLink()) {
        throw Object.assign(new Error('cannot replace a non-file copy destination'), { code: 'EISDIR' });
      }
      fs.unlinkSync(to);
    }
    return true;
  };
  fs.cpSync(source, target, { ...options, recursive: true, filter });
}
