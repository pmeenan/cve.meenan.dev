/**
 * Generate the relay's pinned surface from the TypeScript, after the export.
 *
 * **What this exists to prevent is the endpoint being a general-purpose LLM.**
 * The relay used to take the system prompt and the tool definitions from the
 * caller, which made it a free assistant for anyone who found the URL — the
 * rate limit was the only thing standing between us and that, and a rate limit
 * is a poor substitute for "it cannot do the thing". Pinning both server-side
 * means the endpoint can only ever run CVE analysis against our schema with our
 * five read-only tools, whatever is posted to it. That is worth far more than a
 * low request cap, and it is what let the cap be raised tenfold.
 *
 * Generated rather than hand-copied, for the reason `build-sw.mjs` derives its
 * precache list from `dist/` (D-048): the prompt and the schemas already exist
 * in `lib/chat.ts` and `lib/tools.ts`, the client validates against the same
 * `TOOLS`, and a second hand-maintained copy in PHP would drift the first time
 * a tool gained an argument. Then the model would be told about a tool whose
 * arguments the client refuses — the worst of both.
 *
 * Runs as `postbuild` and writes into `dist/`, so nothing generated lands in
 * the tree and the ordinary rsync deploys it (D-003).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { systemPrompt } from '../lib/chat.ts'
import { TOOLS } from '../lib/tools.ts'

const ROOT = resolve(process.env.SERVE_ROOT ?? 'dist')
const OUT = join(ROOT, 'api', 'surface.php')

const surface = {
  /** Stamped so a served surface can be matched to a build when diagnosing. */
  generated: new Date().toISOString(),
  system: systemPrompt(),
  tools: TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })),
}

if (!surface.system || surface.tools.length === 0) {
  throw new Error('build-surface: refusing to write an empty prompt or tool list')
}

// A PHP file rather than JSON, so a direct request executes it and returns
// nothing instead of serving the prompt to anyone who guesses the URL. Not a
// secret — the tool schemas go to the model anyway, and D-044 assumes
// injection succeeds — but there is no reason to publish it either.
mkdirSync(join(ROOT, 'api'), { recursive: true })
writeFileSync(OUT, `<?php return ${JSON.stringify(JSON.stringify(surface))};\n`)
console.log(
  `chat surface: ${surface.system.length} chars of prompt, ${surface.tools.length} tools -> ${OUT}`
)
