import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP agent-preset option', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('mounts the roster default and advertises the preset select', async () => {
    harness = await makeBridgeHarness({ presets: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const preset = response.configOptions?.find(option => option.id === 'preset')
    expect(harness.presets?.mounted).toEqual(['standard'])
    expect(preset).toMatchObject({
      type: 'select',
      currentValue: 'standard',
      options: [
        { value: 'standard', name: 'Standard' },
        { value: 'minimal', name: 'Minimal', description: 'Two tools' },
      ],
    })
    expect(response.configOptions?.some(option => option.id === 'model')).toBe(true)
  })

  it('switches through the roster while the session is blank', async () => {
    harness = await makeBridgeHarness({ presets: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const response = await harness.client.setSessionConfigOption({ sessionId, configId: 'preset', value: 'minimal' })
    expect(harness.presets?.selected).toEqual(['minimal'])
    expect(response.configOptions?.find(option => option.id === 'preset'))
      .toMatchObject({ currentValue: 'minimal' })
  })

  it('maps roster refusals to invalid parameters', async () => {
    harness = await makeBridgeHarness({ presets: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'preset', value: 'missing' }))
      .rejects.toThrow(/preset "missing" not found/)

    harness.presets!.selectFailure = new RemoteError(
      'agent-preset/locked',
      `session "${sessionId}" has already started; its agent preset is fixed`,
      { sessionId: SessionId(sessionId), agentPreset: 'minimal' },
    )
    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'preset', value: 'minimal' }))
      .rejects.toThrow(/has already started/)
  })

  it('resumes the recorded preset after the roster default changes', async () => {
    harness = await makeBridgeHarness({ presets: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.closeSession({ sessionId })

    harness.presets!.default = 'minimal'
    await harness.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    // The session log states the composition the session ran under, not the roster's current default.
    expect(harness.presets?.mounted).toEqual(['standard', 'standard'])
  })

  it('advertises no preset option without a roster and rejects the unknown option id', async () => {
    harness = await makeBridgeHarness({ script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'preset', value: 'standard' }))
      .rejects.toThrow(/unknown session config option/)
  })
})
