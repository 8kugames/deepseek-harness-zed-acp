// esbuild bundles this package's own sources into `dist/`; every dependency
// stays external. Inside a dsh profile the `@deepseek-ai/*` imports resolve
// through the profile runtime resolver against the host installation, so only
// the registry-declared dependencies (@agentclientprotocol/sdk, schemastery,
// dsh-brand, commander) are expected in the plugin's own node_modules.
import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
}

await Promise.all([
  build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' }),
  build({ ...shared, entryPoints: ['src/startup.ts'], outfile: 'dist/startup.js' }),
])
