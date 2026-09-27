/** Structural contract of the shipped agent-preset declaration patches. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const SHIPPED: ReadonlyArray<{ file: string; id: string; order: number }> = [
  { file: 'standard.patch.yml', id: 'standard', order: 1 },
  { file: 'ptc.patch.yml', id: 'ptc', order: 2 },
  { file: 'minimal.patch.yml', id: 'minimal', order: 3 },
  { file: 'cordis.patch.yml', id: 'cordis', order: 4 },
]

/** Parse a bundle patch for structural checks; loader `!!js` expressions read as opaque strings. */
function loadPatch(relativePath: string): unknown {
  return load(readFileSync(relativePath, 'utf8').replaceAll('!!js ', '!!str '))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Flatten every row a patch file inserts, ignoring id-addressed overrides. */
function insertedRows(patch: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(patch)) throw new Error('patch root must be an array of items')
  const rows: Array<Record<string, unknown>> = []
  for (const item of patch) {
    if (!isRecord(item) || !Array.isArray(item.insert)) continue
    for (const row of item.insert) {
      if (isRecord(row)) rows.push(row)
    }
  }
  return rows
}

describe('shipped agent-preset declarations', () => {
  it.each(SHIPPED)('declares $id as one @deepseek-ai/dsh-agent-preset row', ({ file, id, order }) => {
    const rows = insertedRows(loadPatch(`presets/${file}`))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error(`presets/${file} inserts no row`)
    expect(row.name).toBe('@deepseek-ai/dsh-agent-preset')
    if (!isRecord(row.config)) throw new Error(`presets/${file} row carries no config record`)
    const { plugins, ...identity } = row.config
    expect(identity.id).toBe(id)
    expect(identity.order).toBe(order)
    expect(Array.isArray(plugins) && plugins.length > 0).toBe(true)
  })

  it('ships a declaration for the preset default the registry row names', () => {
    const registry = insertedRows(loadPatch('cordis.patch.yml')).find(row => row.id === 'agent-preset-registry')
    if (registry === undefined || !isRecord(registry.config)) {
      throw new Error('cordis.patch.yml inserts no agent-preset-registry row with config')
    }
    // The failing state this guards against: a registry default whose roster
    // never materializes, so every session/new dies on resolve().
    expect(SHIPPED.map(entry => entry.id)).toContain(registry.config.default)
  })

  it('lists every preset patch in the bundle manifest', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      files: string[]
      dsh: { bundle: { patch: string[] } }
    }
    expect(manifest.dsh.bundle.patch).toEqual([
      './cordis.patch.yml',
      ...SHIPPED.map(entry => `./presets/${entry.file}`),
    ])
    expect(manifest.files).toContain('presets')
  })
})
