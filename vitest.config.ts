import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/*.spec.ts'],
    // The bridge harness boots real cordis scopes and a JSONL persistence
    // tree per spec; the default thread pool isolates them adequately.
    pool: 'threads',
    testTimeout: 30000,
  },
})
