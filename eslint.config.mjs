// eslint-config-next 16 default-exports a flat-config array, not a factory.
import next from 'eslint-config-next'

const config = [
  { ignores: ['dist/**', '.next/**', 'node_modules/**', 'public/sqlite/**', 'pipeline/**'] },
  ...next,
]

export default config
