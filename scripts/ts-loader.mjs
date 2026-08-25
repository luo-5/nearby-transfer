import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      try {
        const targetUrl = new URL(tsSpecifier, context.parentURL);
        if (fs.existsSync(fileURLToPath(targetUrl))) {
          return await nextResolve(targetUrl.href, context);
        }
      } catch {}
    }
    throw err;
  }
}
