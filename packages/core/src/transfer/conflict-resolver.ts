/**
 * Conflict resolution strategies for receive-side file collisions.
 * When a file already exists at the target path, these strategies
 * decide what to do: overwrite it, rename the incoming file, or skip.
 */

import { existsSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';

export type ConflictStrategy = 'overwrite' | 'rename-new' | 'skip';

export function resolveConflict(targetPath: string, strategy: ConflictStrategy): string {
  if (!existsSync(targetPath)) return targetPath;

  switch (strategy) {
    case 'overwrite':
      return targetPath;
    case 'skip':
      return '';
    case 'rename-new': {
      const dir = dirname(targetPath);
      const ext = extname(targetPath);
      const name = basename(targetPath, ext);
      let counter = 1;
      let candidate = join(dir, `${name}.new${counter}${ext}`);
      while (existsSync(candidate)) {
        counter++;
        candidate = join(dir, `${name}.new${counter}${ext}`);
      }
      return candidate;
    }
    default:
      return targetPath;
  }
}
