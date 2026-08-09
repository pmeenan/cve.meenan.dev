/**
 * Let plain `node` import this project's TypeScript.
 *
 * Node 24 strips types on its own (`--experimental-strip-types`) and gets all
 * the way to the imports before failing: TypeScript writes `from './stall'`
 * where Node wants `./stall.ts`, so every internal import 404s with
 * `ERR_MODULE_NOT_FOUND`. This adds the extension back and nothing else.
 *
 * Here rather than a bundler because the alternative was depending on a
 * transitive `rolldown` that arrived with vitest — a build step resting on
 * somebody else's dependency tree is a build step that breaks on an unrelated
 * upgrade. Fifteen lines and no new package.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    // Relative, and with no extension of its own: the TypeScript spelling.
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s(x)?$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context)
      } catch {
        // Fall through: it may be a directory import or genuinely extensionless.
      }
    }
    return next(specifier, context)
  },
})
