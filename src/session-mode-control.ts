/**
 * The ACP session-mode projection over one Agent's plan-mode service: the
 * legacy `SessionModeState` clients read from `session/new` and the `mode`
 * config option current clients render in their mode slot. Both shapes read the
 * same two values from the same service, so the two wire APIs cannot disagree.
 * @module @8kugames/dsh-zed-acp/session-mode-control
 */

import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import { DEFAULT_MODE_ID, PLAN_MODE_ID } from './updates.ts'

/** The config option id the session-mode select advertises. */
export const SESSION_MODE_CONFIG_ID = 'session_mode'

const DEFAULT_MODE = {
  id: DEFAULT_MODE_ID,
  name: 'Default',
  description: 'Full editing and execution tools.',
} as const

const PLAN_MODE = {
  id: PLAN_MODE_ID,
  name: 'Plan',
  description: 'Read-only exploration that ends in a plan for review.',
} as const

/** Caller-correctable session-mode selection failure. */
export class AcpSessionModeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpSessionModeConfigError'
  }
}

/** Build the advertised mode state from the plan-mode service's current selection. */
export function modeState(planMode: PlanModeController, agent: Agent): SessionModeState {
  return {
    currentModeId: planMode.get(agent).active ? PLAN_MODE_ID : DEFAULT_MODE_ID,
    availableModes: [DEFAULT_MODE, PLAN_MODE],
  }
}

/**
 * Project and switch one Agent's collaboration mode. Absent whenever the
 * session's composition provides no plan-mode service: the bridge then
 * advertises no mode option and the legacy mode state stays `undefined`.
 */
export class AcpSessionModeControl {
  /**
   * @param agent - the exact Agent whose plan state this control projects.
   * @param resolve - the session's plan-mode service, resolved per call so a
   * preset switch that mounts a new composition is reflected without a rebuild.
   */
  constructor(
    private readonly agent: Agent,
    private readonly resolve: () => PlanModeController | undefined,
  ) {}

  /**
   * Build the `mode` select from the same two values the legacy mode state
   * advertises, so a client rendering either shape sees one vocabulary.
   * @returns the config option, or `undefined` while no plan-mode composes.
   */
  option(): SessionConfigOption | undefined {
    const planMode = this.resolve()
    if (planMode === undefined) return undefined
    const state = modeState(planMode, this.agent)
    return {
      id: SESSION_MODE_CONFIG_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: state.currentModeId,
      options: state.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    }
  }

  /**
   * Switch the Agent's collaboration mode. This is the same `planMode.set`
   * call the legacy `session/set_mode` path makes, so a selection through
   * either API lands in one state and reaches the client as one
   * `current_mode_update`.
   * @param value - one of the two advertised mode ids.
   */
  set(value: unknown): void {
    if (value !== DEFAULT_MODE_ID && value !== PLAN_MODE_ID) {
      throw new AcpSessionModeConfigError(`unknown mode: ${String(value)}`)
    }
    const planMode = this.resolve()
    if (planMode === undefined) {
      throw new AcpSessionModeConfigError('session modes are not available in this deployment')
    }
    planMode.set(this.agent, value === PLAN_MODE_ID)
  }
}
