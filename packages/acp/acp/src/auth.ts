/**
 * ACP authentication surface: the advertised `deepseek-api-key` method and the
 * credential resolution behind `authenticate` and `auth_required` refusals.
 *
 * The check mirrors the DeepSeek provider's own per-request resolution so a
 * client cannot reach a session that would fail its first model request, and
 * so an added key reaches the next handshake without a restart.
 * @module @deepseek-ai/dsh-acp/auth
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { RequestError, type AuthMethod } from '@agentclientprotocol/sdk'

/** The one advertised method id; clients echo it in `authenticate`. */
export const ACP_AUTH_METHOD_ID = 'deepseek-api-key'

/** The credential reference checked when `apiKeyEnv` is not configured. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * The advertised authentication methods. The agent-type (default) method has
 * the client call `authenticate` while this server validates the credential
 * itself, so no interactive login flow exists to support.
 * @returns the immutable method list sent in every `initialize` response.
 */
export function acpAuthMethods(): AuthMethod[] {
  return [{
    id: ACP_AUTH_METHOD_ID,
    name: 'DeepSeek API key',
    description: 'Resolves the configured API key credential (by default the '
      + `${DEFAULT_API_KEY_ENV} environment variable) and refuses the session when it is missing`,
  }]
}

/**
 * Resolve and validate the deployment-owned credential reference.
 * @param apiKeyEnv - configured environment-variable name, or `undefined` for the default.
 * @returns the branded credential reference.
 */
export function resolveApiKeyRef(apiKeyEnv: string | undefined): CredentialRef {
  return credentialRef(apiKeyEnv ?? DEFAULT_API_KEY_ENV)
}

/**
 * Resolve the configured credential without exposing its value.
 * @param ctx - ACP plugin context carrying the optional credentials seam.
 * @param ref - the credential reference to resolve.
 * @returns the usable key, or `undefined` while unconfigured or unusable.
 */
export async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  let value: string | undefined
  if (credentials !== undefined) {
    value = (await credentials.resolve(ref))?.value
  } else {
    // Without the seam there is no managed store to rank against, so the
    // launch environment is the whole credential plane.
    value = launchEnvironmentOf(ctx).get(ref)?.value
  }
  const checked = normalizeApiKey(value ?? '')
  return checked.ok ? checked.value : undefined
}

/**
 * Validate an `authenticate` request: only the advertised method is accepted,
 * and the credential must resolve.
 * @param ctx - ACP plugin context carrying the optional credentials seam.
 * @param ref - the credential reference to resolve.
 * @param methodId - the method id the client echoed.
 * @throws {RequestError} invalid parameters for an unknown method id, or an
 *   explained internal error while the credential is missing.
 */
export async function authenticate(ctx: Context, ref: CredentialRef, methodId: string): Promise<void> {
  if (methodId !== ACP_AUTH_METHOD_ID) {
    throw RequestError.invalidParams(undefined, `unknown authentication method: ${methodId}`)
  }
  if (await resolveApiKey(ctx, ref) === undefined) {
    throw RequestError.internalError(
      undefined,
      `no API key resolved from ${ref}; export ${ref} in the launching environment `
      + 'or store it through the credentials service, then authenticate again',
    )
  }
}
