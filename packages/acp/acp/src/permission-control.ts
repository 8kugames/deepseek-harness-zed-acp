/**
 * The ACP `permission` config option over one Session's permission preset:
 * the deployment's preset table as a select, and the live switch through the
 * permission service's own record-and-apply path.
 * @module @deepseek-ai/dsh-acp/permission-control
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'

/** The config option id the permission select advertises. */
export const PERMISSION_CONFIG_ID = 'permission'

/** Caller-correctable permission selection failure. */
export class AcpPermissionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpPermissionConfigError'
  }
}

/**
 * Project and switch one Session's permission preset through the ACP
 * `permission` select. Unlike agent presets, permission presets are live:
 * the switch records and applies at any point in the session, and the next
 * tool call runs under the new sandbox and approval knobs. Absent whenever
 * the deployment composes no permission service.
 */
export class AcpPermissionControl {
  constructor(
    private readonly permissions: PermissionPresetService,
    private readonly session: Session,
  ) {}

  /**
   * Build the advertised select from the preset table, keeping the effective
   * state selectable even when it matches no table entry (`custom`).
   * @returns the config option.
   */
  option(): SessionConfigOption {
    const current = this.permissions.current(this.session)
    const options = this.permissions.names.map(name => this.permissions.optionOf(name))
    if (!options.some(option => option.value === current)) {
      options.unshift(this.permissions.optionOf(current))
    }
    return {
      id: PERMISSION_CONFIG_ID,
      name: 'Permissions',
      type: 'select',
      currentValue: current,
      options,
    }
  }

  /**
   * Switch the Session's permission preset: record the choice and apply its
   * sandbox and approval knobs through the permission service.
   * @param value - the selected preset name.
   */
  set(value: unknown): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AcpPermissionConfigError(`${PERMISSION_CONFIG_ID} requires a preset name`)
    }
    try {
      this.permissions.set(this.session, value)
    } catch (error: unknown) {
      throw error instanceof AcpPermissionConfigError
        ? error
        : new AcpPermissionConfigError(error instanceof Error ? error.message : String(error))
    }
  }
}
