import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP permission option', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises the preset table with the composed default selected', async () => {
    harness = await makeBridgeHarness({ permissions: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const permission = response.configOptions?.find(option => option.id === 'permission')
    expect(permission).toMatchObject({ type: 'select', currentValue: 'workspace-write' })
    const names = permission !== undefined && permission.type === 'select'
      ? permission.options.flatMap(option => 'group' in option ? option.options.map(entry => entry.value) : [option.value])
      : []
    expect(names).toEqual(expect.arrayContaining(['read-only', 'workspace-write', 'danger-full-access']))
  })

  it('switches the live permission preset at any point in the session', async () => {
    harness = await makeBridgeHarness({ permissions: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const response = await harness.client.setSessionConfigOption({
      sessionId,
      configId: 'permission',
      value: 'danger-full-access',
    })
    expect(response.configOptions?.find(option => option.id === 'permission'))
      .toMatchObject({ currentValue: 'danger-full-access' })
  })

  it('maps an unknown preset name to invalid parameters', async () => {
    harness = await makeBridgeHarness({ permissions: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'yolo' }))
      .rejects.toThrow(/unknown preset "yolo"/)
  })

  it('advertises no permission option without the permission service', async () => {
    harness = await makeBridgeHarness({ script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(harness.updates).toHaveLength(0)
    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'read-only' }))
      .rejects.toThrow(/unknown session config option/)
  })
})
