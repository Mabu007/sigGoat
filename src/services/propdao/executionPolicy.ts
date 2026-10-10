/**
 * PROPDAO EXECUTION POLICY
 * ========================
 * The single decision point for whether FundAGoat may place an order.
 *
 * READ THIS BEFORE ENABLING ANYTHING
 *
 *   PropDAO's Terms of Service (last updated 25 June 2026) grant a licence to
 *   "access and use the Services for PERSONAL, NON-COMMERCIAL USE" (§10), and
 *   separately prohibit "use automated systems WITHOUT AUTHORIZATION" (§9).
 *
 *   PropDAO's own Rulebook (§4.2) and FAQ state that for an individual trader,
 *   "Automated trading is permitted" — bots, EAs and AI agents are allowed.
 *
 *   Those two statements are compatible for a trader automating their own
 *   account. They are NOT obviously compatible for a THIRD PARTY operating a
 *   paid service on a customer's behalf, which is what FundAGoat is. Nothing
 *   on propdao.finance grants that permission: there is no affiliate program,
 *   no delegated/OAuth access, no read-only key, and no clause permitting
 *   third-party commercial integration.
 *
 *   THEREFORE: execution ships DISABLED, and stays disabled until written
 *   authorisation from PropDAO covering commercial third-party API use has
 *   been obtained. This is not a configuration oversight — the flag defaults
 *   to false and every guard below reads it.
 *
 * WHAT THIS MEANS IN PRACTICE
 *   - Read-only operations (account discovery, risk, positions, orders,
 *     trades, markets) work normally and are what the UI exposes.
 *   - Every write operation returns `EXECUTION_DISABLED` — a clear, honest
 *     refusal — rather than a fake success or a silent no-op.
 *
 * HOW TO ENABLE (only after authorisation)
 *   Set `PROPDAO_EXECUTION_ENABLED=true` AND
 *   `PROPDAO_EXECUTION_AUTHORISED=true` in the server environment, and set
 *   `PROPDAO_EXECUTION_TERMS_REFERENCE` to the authorisation you are relying
 *   on. All three must be present. Two environment variables rather than one
 *   is deliberate: the first says the feature is switched on, the second is a
 *   standing assertion that the commercial-use question was answered, and the
 *   third records what that answer was.
 */

export type ExecutionDecision =
  | { allowed: true; reason: 'authorised' }
  | {
      allowed: false;
      code: ExecutionBlockedReason;
      /** Safe to show a user. Never contains a credential. */
      message: string;
    };

export type ExecutionBlockedReason =
  | 'EXECUTION_DISABLED'
  | 'TERMS_NOT_VERIFIED'
  | 'NO_CREDENTIAL'
  | 'ACCOUNT_NOT_SELECTED'
  | 'ACCOUNT_NOT_OWNED'
  | 'ACCOUNT_NOT_TRADEABLE'
  | 'PROPOSAL_EXPIRED'
  | 'RISK_CHECK_FAILED'
  | 'MARKET_UNAVAILABLE';

const TERMS_CONTEXT =
  'PropDAO authorises automated trading for individual traders (Rules §4.2), but its ' +
  'Terms of Service §10 grant access only for "personal, non-commercial use", and §9 ' +
  'prohibits "use automated systems without authorization". Operating a paid ' +
  'third-party service that places trades on a customer\'s account falls outside ' +
  'that grant on the face of the terms. Written authorisation from PropDAO ' +
  'covering commercial third-party API use is required before this can be enabled.';

export interface ExecutionPolicyInput {
  /** Whether the write operation the caller wants is one the API supports. */
  capabilitySupported: boolean;
  /** Whether the user has a usable PropDAO key in the vault. */
  hasCredential: boolean;
  /** The account the request targets, already proven to belong to the user. */
  accountId?: string | null;
  /** Provider-reported account status, when known. */
  accountStatus?: string | null;
  /** Whether the approval is still within its expiry. */
  proposalExpired?: boolean;
}

function envFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/** True when this deployment is configured to permit order placement at all. */
export function isExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.PROPDAO_EXECUTION_ENABLED);
}

/**
 * Whether commercial use has been explicitly asserted as authorised.
 *
 * A separate variable from the enable flag on purpose — see the header.
 */
export function isCommercialUseAuthorised(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.PROPDAO_EXECUTION_AUTHORISED);
}

/** The authorisation reference recorded in the deployment, if any. */
export function executionTermsReference(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PROPDAO_EXECUTION_TERMS_REFERENCE?.trim() || null;
}

/**
 * The deterministic, server-side decision.
 *
 * ORDER MATTERS. The flag checks come first so that a disabled deployment
 * reports `EXECUTION_DISABLED` regardless of anything else — the operator's
 * switch must be the answer, not a downstream precondition. Only once
 * execution is enabled do the request-specific checks run.
 */
export function evaluateExecution(
  input: ExecutionPolicyInput,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionDecision {
  // 1. The deployment switch.
  if (!isExecutionEnabled(env)) {
    return {
      allowed: false,
      code: 'EXECUTION_DISABLED',
      message:
        'Order placement is switched off for this deployment. FundAGoat can analyse markets and prepare proposals, ' +
        'but it will not place trades until PropDAO confirms in writing that a third-party commercial integration ' +
        `is permitted. ${TERMS_CONTEXT}`,
    };
  }

  // 2. The commercial-use assertion. Enabling the switch without this is a
  //    misconfiguration, and the safe reading of a misconfiguration is "off".
  if (!isCommercialUseAuthorised(env)) {
    return {
      allowed: false,
      code: 'TERMS_NOT_VERIFIED',
      message:
        'Order placement is switched on but commercial-use authorisation has not been recorded. ' +
        TERMS_CONTEXT,
    };
  }

  // 3. Request preconditions.
  if (!input.capabilitySupported) {
    return {
      allowed: false,
      code: 'RISK_CHECK_FAILED',
      message: 'This operation is not supported by the PropDAO API and cannot be performed.',
    };
  }
  if (!input.hasCredential) {
    return {
      allowed: false,
      code: 'NO_CREDENTIAL',
      message: 'Connect a PropDAO API key in Settings before executing a trade.',
    };
  }
  if (!input.accountId) {
    return {
      allowed: false,
      code: 'ACCOUNT_NOT_SELECTED',
      message: 'Select the PropDAO account this trade belongs to.',
    };
  }
  // 4. The account must be in a state that accepts orders. A breached account
  //    rejects them server-side anyway; failing here gives a better message.
  const status = (input.accountStatus ?? '').toLowerCase();
  if (status && !['active', 'passed', 'funded'].includes(status)) {
    return {
      allowed: false,
      code: 'ACCOUNT_NOT_TRADEABLE',
      message: `This account is "${input.accountStatus}" and cannot accept new orders.`,
    };
  }
  if (input.proposalExpired) {
    return {
      allowed: false,
      code: 'PROPOSAL_EXPIRED',
      message: 'This proposal has expired. Review the current market before approving a new one.',
    };
  }

  return { allowed: true, reason: 'authorised' };
}

/**
 * The status surface the UI and the public settings endpoint read.
 *
 * Returns no secrets and no account data — only whether execution is possible
 * and, when it is not, why.
 */
export function executionPolicyStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  authorised: boolean;
  termsReference: string | null;
  /** One-line summary for the Settings UI. */
  summary: string;
  termsSummary: string;
} {
  const enabled = isExecutionEnabled(env);
  const authorised = isCommercialUseAuthorised(env);
  return {
    enabled,
    authorised,
    termsReference: executionTermsReference(env),
    summary: enabled && authorised
      ? 'Order execution is enabled.'
      : 'Order execution is disabled. FundAGoat analyses markets and prepares proposals, but does not place trades.',
    termsSummary: enabled && authorised
      ? `Authorised via ${executionTermsReference(env) ?? 'an unset terms reference — record this.'}`
      : TERMS_CONTEXT,
  };
}