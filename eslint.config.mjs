// eslint-config-next 16 default-exports a flat-config array, not a factory.
import next from 'eslint-config-next'

const config = [
  {
    ignores: [
      'dist/**',
      '.next/**',
      'node_modules/**',
      'public/sqlite/**',
      'pipeline/**',
      // Not JavaScript until `scripts/build-sw.mjs` substitutes its two
      // placeholders; the generated `dist/sw.js` is covered by `dist/**`.
      'scripts/sw.template.js',
    ],
  },
  ...next,
]

export default config
