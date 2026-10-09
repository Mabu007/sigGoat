/**
 * API BUNDLE BUILD
 * ================
 * Bundles the Vercel serverless entry (`src/server/entry.ts`) into
 * `.api-build/index.mjs`, which the committed `api/index.js` shim re-exports.
 *
 * WHY BUNDLING IS NEEDED AT ALL
 *
 * Vercel's Node builder transpiles each TypeScript file separately and runs the
 * result as-is. The original `api/index.ts` did `import '../src/server/env'`,
 * which transpiles to a specifier with no file extension — and Node's ESM
 * resolver rejects that. Every production request failed with
 * ERR_MODULE_NOT_FOUND before a single route ran. The local `tsx` runner
 * resolves extensionless paths, which is exactly why this only ever showed up
 * on Vercel.
 *
 * esbuild resolves and inlines the whole relative import graph at build time
 * and emits specifiers with extensions, so there is no runtime resolution left
 * to fail.
 *
 * WHY THE OUTPUT IS NOT `api/index.js`
 *
 * `api/index.js` must stay COMMITTED. Vercel resolves the `functions` map in
 * `vercel.json` before it runs the build command, so on a Git-connected deploy
 * that pattern is checked against a fresh clone. A gitignored, build-generated
 * entry point fails the build with `[unused_function]`. Writing the bundle over
 * the committed shim would also destroy the fix on every build.
 *
 * See api/index.js for the full explanation of the shim.
 *
 * NODE_MODULES STAYS EXTERNAL
 *
 * firebase-admin, express and dotenv are loaded normally from node_modules
 * rather than inlined. Bundling firebase-admin pulls in its dynamic
 * `require()` graph, which is neither tree-shakeable nor statically analysable
 * and would produce a brittle multi-megabyte file.
 */

import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bundle lands in `.api-build/`, NOT in `api/`.
 *
 * `api/index.js` is a committed three-line shim (see that file for why). If the
 * bundle were written there instead, the shim would overwrite itself and the
 * committed shim would be lost on the next build — taking the fix with it.
 */
const outdir = path.join(root, '.api-build');
const outfile = path.join(outdir, 'index.mjs');

void outfile; // documented destination; esbuild derives the name from outdir

await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, 'src', 'server', 'entry.ts')],
  outdir,
  entryNames: 'index',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
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

console.log(`[build-api] wrote .api-build/index.mjs (${Math.round(bytes / 1024)} kB)`);

// Fail loudly if the committed shim and this output have drifted apart.
const shim = path.join(root, 'api', 'index.js');
if (!existsSync(shim)) {
  throw new Error(
    `api/index.js is missing. It must stay committed: Vercel resolves the\n` +
      `\`functions\` map in vercel.json BEFORE running the build command, so the\n` +
      `entry point has to exist in a fresh clone.`,
  );
}

const contents = readFileSync(shim, 'utf8');
if (!contents.includes('.api-build/index.mjs')) {
  throw new Error(
    'api/index.js does not import ../.api-build/index.mjs. Vercel would build a\n' +
      'function that never loads the bundle.',
  );
}