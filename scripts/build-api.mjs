/**
 * API BUNDLE BUILD
 * ================
 * Bundles the Vercel serverless entry (`src/server/entry.ts`) into
 * `api/index.js`.
 *
 * WHY THIS EXISTS
 *
 * Vercel's Node builder transpiles each TypeScript file separately and runs the
 * result as-is. `api/index.ts` did `import '../src/server/env'`, which
 * transpiles to `import '../src/server/env'` — and Node's ESM resolver rejects
 * a specifier with no file extension. Every production request therefore
 * failed with ERR_MODULE_NOT_FOUND before a single route ran. The local `tsx`
 * runner resolves extensionless paths, which is exactly why this only ever
 * showed up on Vercel.
 *
 * esbuild resolves and inlines the whole relative import graph at build time
 * and emits specifiers with extensions, so there is no runtime resolution left
 * to fail.
 *
 * NODE_MODULES STAYS EXTERNAL
 *
 * firebase-admin, express and dotenv are loaded normally from node_modules
 * rather than inlined. Bundling firebase-admin pulls in its dynamic
 * `require()` graph, which is neither tree-shakeable nor statically analysable
 * and would produce a brittle multi-megabyte file.
 */

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'api', 'index.js');

await rm(path.join(root, 'api', 'index.js'), { force: true });

const result = await build({
  entryPoints: [path.join(root, 'src', 'server', 'entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Every bare import stays a runtime import from node_modules.
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  metafile: true,
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

const bytes = Object.values(result.metafile.outputs).reduce(
  (total, output) => total + output.bytes,
  0,
);

console.log(`[build-api] wrote api/index.js (${Math.round(bytes / 1024)} kB)`);