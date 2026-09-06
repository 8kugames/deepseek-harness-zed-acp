import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP authentication surface', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    delete process.env.ACP_AUTH_TEST_KEY
  })

  async function initializedHarness(): Promise<BridgeHarness> {
    harness = await makeBridgeHarness({ config: { apiKeyEnv: 'ACP_AUTH_TEST_KEY' } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('advertises the one agent-type method and the package version', async () => {
    const bridge = await makeBridgeHarness()
    const initialized = await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await bridge.dispose()

    expect(initialized.authMethods).toHaveLength(1)
    expect(initialized.authMethods?.[0]).toMatchObject({
      id: 'deepseek-api-key',
      name: 'DeepSeek API key',
    })
    expect(typeof initialized.authMethods?.[0]?.description).toBe('string')
    expect(initialized.agentInfo?.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('resolves the key through the configured credential reference', async () => {
    const bridge = await initializedHarness()
    await expect(bridge.client.authenticate({ methodId: 'deepseek-api-key' })).rejects.toThrow(/no API key resolved/)

    process.env.ACP_AUTH_TEST_KEY = 'sk-test-key'
    await expect(bridge.client.authenticate({ methodId: 'deepseek-api-key' })).resolves.toEqual({})
  })

  it('rejects unknown method ids without touching the credential', async () => {
    const bridge = await initializedHarness()
    process.env.ACP_AUTH_TEST_KEY = 'sk-test-key'
    await expect(bridge.client.authenticate({ methodId: 'browser-login' })).rejects.toThrow(/unknown authentication method/)
  })
})
