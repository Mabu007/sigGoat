/**
 * VERCEL SERVERLESS FUNCTION ENTRY (committed shim)
 * ==================================================
 * This file IS committed to git. It is not a build artifact.
 *
 * WHY THIS FILE IS COMMITTED AND THE BUNDLE IS NOT
 *
 * Vercel resolves the `functions` map in `vercel.json` during a phase that runs
 * BEFORE the build command. On a Git-connected deployment it therefore looks at
 * a fresh clone, where a gitignored, build-generated `api/index.js` does not
 * exist, and fails the whole build with:
 *
 *   Error [unused_function] The pattern "api/index.js" defined in `functions`
 *   doesn't match any Serverless Functions inside the `api` directory.
 *
 * Empirically confirmed from `.vercel/output/diagnostics/cli_traces.json`:
 * `vc.detectBuilders` (timestamp 8689368758) completes before `vc.doBuild`
 * (timestamp 8689176939). Builder detection cannot see anything the build
 * command has not produced yet.
 *
 * This was invisible from `vercel --prod`, because that path uploads the working
 * tree — where the locally-built `api/index.js` happens to be sitting on disk.
 * Only the Git-connected build reproduced it.
 *
 * WHY THE SHIM RATHER THAN THE BUNDLE ITSELF
 *
 * Committing the ~1.4 MB esbuild output would let the pattern match, but it
 * would be a stale duplicate of `src/`, checked in and liable to drift from the
 * source it is generated from. Committing three lines that import the freshly
 * built bundle keeps a single source of truth and still satisfies the pattern.
 *
 * WHY THE IMPORT SPECIFIER IS ABSOLUTE
 *
 * `../.api-build/index.mjs` is resolved against this file's own directory by
 * Node's ESM resolver. The `@vercel/node` builder traces and bundles this
 * import during the build, after `.api-build/index.mjs` has been written by
 * `scripts/build-api.mjs`.
 *
 * If the bundle is somehow missing, this fails LOUDLY at import time rather than
 * exporting a stub that would turn every API route into a silent 200.
 */

export { default } from '../.api-build/index.mjs';