/**
 * Identity types for the CRC RWork sign-in route.
 *
 * The desktop shell completes the login in its own window and hands the
 * resulting session cookie to the Host through
 * {@link ExternalAccountSession}; nothing here is ever rendered.
 *
 * @module @deepseek-ai/dsh-hrzszy-account/types
 */

/** Provider tag carried by {@link ExternalAccountSession}. */
export const RWORK_PROVIDER = 'rwork'

/**
 * A session captured outside the Host, in the owning provider's own format.
 *
 * `cookie` is the deployment session cookie header, and it is the only
 * credential the RWork identity endpoint accepts; it never crosses a Remote
 * boundary and is only stored through the credential seam.
 */
export interface ExternalAccountSession {
  /** Which external login produced this session. */
  readonly provider: string
  /** Raw `Cookie` header value captured from the finished login. */
  readonly cookie: string
}

/** Identity the RWork gateway reports for the signed-in employee. */
export interface RworkUser {
  /** Stable employee identifier. */
  readonly id: string
  /** Display name shown next to the avatar. */
  readonly name: string
  /** Avatar image URL; absent when the employee has no picture configured. */
  readonly avatarUrl?: string
  /** Tenant display name, such as the group the employee belongs to. */
  readonly tenant: string
}
