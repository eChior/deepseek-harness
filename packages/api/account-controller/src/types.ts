/** Account Remote values contain no credential payloads. */
export type { AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountProfile, AccountUserId, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Session a desktop shell captured in its own sign-in window and hands to the account provider.
 * Remote boundaries must name a type exported from this non-root subpath, so the shape lives here
 * rather than beside the controller that accepts it.
 */
export interface ExternalSessionInput {
  /** Provider that owns the payload and understands its credential, such as `rwork`. */
  readonly provider: string
  /** Provider-defined credential, such as the cookie header of the captured session. */
  readonly cookie: string
}
