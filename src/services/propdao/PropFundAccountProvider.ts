/**
 * PROPDAO PROVIDER ADAPTER
 * ========================
 * Isolates every PropDAO-specific concern from the rest of FundAGoat.
 *
 * THE STABLE INTERNAL INTERFACE
 *   The agent and the API layer talk to `PropFundAccountProvider` and the
 *   internal `FundAccount` / `AccountRisk` shapes, never to `PropDaoClient`.
 *   That is what lets a second broker be added without touching the risk
 *   validator, and what keeps a PropDAO field rename from rippling through
 *   the execution path.
 *
 * CAPABILITIES ARE DECLARED, NOT DISCOVERED
 *   `PROPDAO_CAPABILITIES` lists what the documented API actually exposes.
 *   Two documented absences matter and are encoded as `false`:
 *
 *     - `modifyOrder` — there is NO PATCH on an order. An "amend" would have
 *       to be cancel-then-replace, which is two non-atomic steps; pretending
 *       it exists would hide a real gap between what a user expects and what
 *       would happen.
 *     - `payout` — "Payout is UI-only for now". There is no `POST /payouts`.
 *
 *   `isSupported` is consulted before any write is attempted, so an
 *   unsupported operation returns a clear refusal rather than a 404.
 *
 * ACCOUNT OWNERSHIP
 *   `resolveAccount` only ever returns accounts returned by `GET /accounts` for
 *   the CALLER'S OWN key. There is no code path that accepts an account id
 *   from a request body and uses it directly, because that would let a user
 *   address an account they do not own.
 */

import {
  PropDaoAccount,
  PropDaoChallengeRules,
  PropDaoClient,
  PropDaoError,
  PropDaoExecutionResult,
  PropDaoMarket,
  PropDaoOrder,
  PropDaoOrderRequest,
  PropDaoPosition,
  PropDaoRisk,
  PropDaoTrade,
  parseChallengeRules,
} from './PropDaoClient';
import {
  ExecutionDecision,
  evaluateExecution,
  executionPolicyStatus,
} from './executionPolicy';
import { describePropDaoError } from './PropDaoClient';
import { redactText } from '../../server/security/redaction';

/* ------------------------------------------------------------------ */
/* Internal account model                                              */
/* ------------------------------------------------------------------ */

export interface FundAccountSummary {
  accountId: string;
  provider: 'propdao';
  /** 'active' | 'funded' | 'passed' | 'failed' | 'expired' | anything else. */
  status: string | null;
  challengeId: string | null;
  /** Present only when the provider supplied it on the account record. */
  rules: PropDaoChallengeRules | null;
}

export interface AccountRiskSnapshot {
  accountId: string;
  equity: number | null;
  balance: number | null;
  /** The binding floor in USD. Below this, the account is closed. */
  floorUsd: number | null;
  /** Which limit binds: 'max' (static drawdown) or 'daily'. */
  floorKind: string | null;
  /** Remaining risk budget in USD: equity - floor. */
  roomUsd: number | null;
  /** Remaining risk budget as the provider reports it, NOT recomputed. */
  roomPct: number | null;
  breached: boolean | null;
  openPositions: number | null;
  /** True when a field was absent — the UI must not render it as zero. */
  incomplete: boolean;
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export interface ProviderCapabilities {
  /** Read the caller's account list. */
  listAccounts: boolean;
  /** Read live risk (equity, floors, remaining headroom). */
  readRisk: boolean;
  /** Read open positions. */
  readPositions: boolean;
  /** Read resting orders. */
  readOrders: boolean;
  /** Read closed trades. */
  readTrades: boolean;
  /** Discover tradable markets and their constraints. */
  discoverMarkets: boolean;

  /* ---- writes: every one of these is gated ---- */
  placeOrder: boolean;
  cancelOrder: boolean;
  closePosition: boolean;
  setStopLossTakeProfit: boolean;
  stopTwap: boolean;

  /**
   * Amend a resting order. FALSE: the API exposes no order-modification
   * endpoint. Amending would be cancel-then-replace, which is not atomic.
   */
  modifyOrder: boolean;

  /**
   * Withdraw profits. FALSE: payouts are terminal-UI-only; no endpoint exists.
   */
  payout: boolean;

  /**
   * Push notifications. FALSE: no webhook endpoint is documented.
   */
  webhooks: boolean;
}

/**
 * What the DOCUMENTED PropDAO v1 API supports.
 *
 * Read-only operations are all `true` because each has a documented endpoint
 * (see PropDaoClient's header table). The three `false` entries are the
 * documented ABSENCES, and they are load-bearing: `isSupported()` turns them
 * into honest refusals instead of 404s at execution time.
 */
export const PROPDAO_CAPABILITIES: ProviderCapabilities = {
  listAccounts: true,
  readRisk: true,
  readPositions: true,
  readOrders: true,
  readTrades: true,
  discoverMarkets: true,

  placeOrder: true,
  cancelOrder: true,
  closePosition: true,
  setStopLossTakeProfit: true,
  stopTwap: true,

  modifyOrder: false,
  payout: false,
  webhooks: false,
};

export type CapabilityName = keyof ProviderCapabilities;

export function isSupported(capability: CapabilityName): boolean {
  return PROPDAO_CAPABILITIES[capability] === true;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

/** A refusal. Every gated path returns one of these rather than throwing. */
export type WriteFailure = { executed: false; code: string; message: string };

/** Uniform shape for every gated write, whether or not it was allowed. */
export type WriteOutcome =
  | { executed: true; result: boolean }
  | { executed: false; code: string; message: string };

export interface PropFundAccountProviderOptions {
  /** Decrypts the caller's key. Supplied by the caller, never stored here. */
  resolveApiKey: () => Promise<string | undefined>;
  /** Injected in tests. */
  clientFactory?: (apiKey: string) => PropDaoClient;
  env?: NodeJS.ProcessEnv;
}

export class PropFundAccountProvider {
  readonly providerId = 'propdao';
  readonly capabilities = PROPDAO_CAPABILITIES;

  constructor(private readonly options: PropFundAccountProviderOptions) {}

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private makeClient(apiKey: string): PropDaoClient {
    return this.options.clientFactory
      ? this.options.clientFactory(apiKey)
      : new PropDaoClient({ apiKey });
  }

  /**
   * Builds a client from the caller's stored key.
   *
   * Returns `null` when no key is stored — the caller reports "not connected"
   * rather than an error. The key is held only for the lifetime of the call
   * and is never stored, cached or logged by this adapter.
   */
  private async client(): Promise<PropDaoClient | null> {
    const apiKey = await this.options.resolveApiKey();
    if (!apiKey || apiKey.trim().length === 0) return null;
    return this.makeClient(apiKey.trim());
  }

  /** Connection probe for the Settings page. Never returns the key. */
  async verifyConnection(): Promise<
    | { connected: true; userId: string; accountCount: number }
    | { connected: false; code: string; message: string }
  > {
    const client = await this.client();
    if (!client) {
      return { connected: false, code: 'NO_CREDENTIAL', message: 'No PropDAO API key is saved.' };
    }
    try {
      const identity = await client.identity();
      const accounts = await client.accounts();
      return {
        connected: true,
        userId: identity.userId,
        accountCount: accounts.length,
      };
    } catch (error) {
      const described = describePropDaoError(error);
      return { connected: false, code: described.code, message: described.message };
    }
  }

  /**
   * Accounts available to THIS key.
   *
   * Ownership comes from the provider: these are the accounts the key's own
   * identity can see. A caller cannot pass an id here.
   */
  async listAccounts(): Promise<FundAccountSummary[]> {
    const client = await this.client();
    if (!client) return [];

    const accounts: PropDaoAccount[] = await client.accounts();
    return accounts.map((account) => ({
      accountId: account.accountId,
      provider: 'propdao' as const,
      status: account.status,
      challengeId: account.challengeId,
      rules: account.challenge ? parseChallengeRules(account.challenge) : null,
    }));
  }

  /**
   * Resolves a caller-supplied account id against the OWNED account list.
   *
   * Returns `null` when the id is not among the accounts this key can see.
   * Every write path goes through here, which is what stops a request body
   * from naming someone else's account.
   */
  async resolveAccount(accountId: string): Promise<FundAccountSummary | null> {
    if (!accountId || typeof accountId !== 'string') return null;
    const owned = await this.listAccounts();
    return owned.find((account) => account.accountId === accountId) ?? null;
  }

  /** Live risk for an account the caller owns. */
  async risk(accountId: string): Promise<AccountRiskSnapshot> {
    const client = await this.client();
    if (!client) {
      return emptyRisk(accountId, 'No PropDAO API key is saved.');
    }

    try {
      const account = await this.resolveAccount(accountId);
      if (!account) {
        return emptyRisk(accountId, 'That account is not available on this PropDAO key.');
      }

      const risk: PropDaoRisk = await client.risk(accountId);

      // `incomplete` is what stops the UI rendering an absent field as 0.
      // A null equity is genuinely different from an equity of zero, and
      // displaying both as "0.00" would misrepresent a trader's real
      // drawdown headroom.
      const incomplete =
        risk.equity === null ||
        risk.floor === null ||
        risk.roomUsd === null;

      return {
        accountId,
        equity: risk.equity,
        balance: risk.balance,
        floorUsd: risk.floor,
        floorKind: risk.floorKind,
        roomUsd: risk.roomUsd,
        roomPct: risk.roomPct,
        breached: risk.breached,
        openPositions: risk.openPositions,
        incomplete,
      };
    } catch (error) {
      return emptyRisk(accountId, describePropDaoError(error).message);
    }
  }

  async positions(accountId: string): Promise<PropDaoPosition[]> {
    const client = await this.client();
    if (!client) return [];
    try {
      if (!(await this.resolveAccount(accountId))) return [];
      return await client.positions(accountId);
    } catch {
      return [];
    }
  }

  async orders(accountId: string): Promise<PropDaoOrder[]> {
    const client = await this.client();
    if (!client) return [];
    try {
      if (!(await this.resolveAccount(accountId))) return [];
      return await client.orders(accountId);
    } catch {
      return [];
    }
  }

  async trades(accountId: string, limit = 100): Promise<PropDaoTrade[]> {
    const client = await this.client();
    if (!client) return [];
    try {
      if (!(await this.resolveAccount(accountId))) return [];
      return await client.trades(accountId, limit);
    } catch {
      return [];
    }
  }

  async markets(): Promise<PropDaoMarket[]> {
    const client = await this.client();
    if (!client) return [];
    try {
      return await client.markets();
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /* Execution — every path below is gated                           */
  /* ---------------------------------------------------------------- */

  /**
   * Places an order, if and only if the deployment allows it.
   *
   * The gate is evaluated HERE, server-side, from server configuration. It
   * does not read anything from the request, and there is no request field
   * that can influence it.
   */
  async executeOrder(
    accountId: string,
    order: PropDaoOrderRequest,
  ): Promise<{ executed: true; result: PropDaoExecutionResult } | WriteFailure> {
    const account = await this.resolveAccount(accountId);

    const decision: ExecutionDecision = evaluateExecution(
      {
        capabilitySupported: isSupported('placeOrder'),
        hasCredential: (await this.client()) !== null,
        accountId,
        accountStatus: account?.status ?? null,
      },
      this.env(),
    );

    if (decision.allowed === false) {
      return { executed: false, code: decision.code, message: decision.message };
    }

    const client = await this.client();
    if (!client) {
      return { executed: false, code: 'NO_CREDENTIAL', message: 'No PropDAO API key is saved.' };
    }

    try {
      const result = await client.placeOrder(accountId, order);
      return { executed: true, result };
    } catch (error) {
      const described = describePropDaoError(error);
      // The message distinguishes "definitely not executed" from "unknown".
      // On TIMEOUT the outcome is genuinely uncertain and the caller must
      // reconcile rather than retry.
      return {
        executed: false,
        code: described.code,
        message: described.message,
      };
    }
  }

  async cancelOrder(accountId: string, orderId: string) {
    return this.gatedWrite('cancelOrder', accountId, async (client) => {
      await client.cancelOrder(accountId, orderId);
      return true;
    });
  }

  async closePosition(accountId: string, positionId: string, percent?: number) {
    return this.gatedWrite('closePosition', accountId, async (client) => {
      await client.closePosition(accountId, positionId, percent);
      return true;
    });
  }

  async setProtection(accountId: string, positionId: string, protection: { sl?: number | null; tp?: number | null }) {
    return this.gatedWrite('setStopLossTakeProfit', accountId, async (client) => {
      await client.setPositionProtection(accountId, positionId, protection);
      return true;
    });
  }

  /**
   * Shared gate for the remaining writes.
   *
   * Refuses BEFORE touching the provider when either the deployment is
   * disabled or the capability does not exist, so an unsupported operation
   * costs no API call and produces a clear explanation.
   */
  async gatedWrite(
    capability: CapabilityName,
    accountId: string,
    run: (client: PropDaoClient) => Promise<boolean>,
  ): Promise<WriteOutcome> {
    if (!isSupported(capability)) {
      return {
        executed: false,
        code: 'CAPABILITY_UNSUPPORTED',
        message: `PropDAO does not expose an endpoint for "${capability}". This operation cannot be performed.`,
      };
    }

    const account = await this.resolveAccount(accountId);
    const decision = evaluateExecution(
      {
        capabilitySupported: true,
        hasCredential: (await this.client()) !== null,
        accountId,
        accountStatus: account?.status ?? null,
      },
      this.env(),
    );
    if (decision.allowed === false) {
      return { executed: false, code: decision.code, message: decision.message };
    }

    const client = await this.client();
    if (!client) {
      return { executed: false, code: 'NO_CREDENTIAL', message: 'No PropDAO API key is saved.' };
    }

    try {
      return { executed: true, result: await run(client) };
    } catch (error) {
      const described = describePropDaoError(error);
      return { executed: false, code: described.code, message: described.message };
    }
  }

  /**
   * Runs an arbitrary gated write.
   *
   * Public so a route can attempt a capability the adapter has no bespoke
   * method for, and — importantly — so the "unsupported capability" refusal is
   * reachable through exactly the same gate every other write uses.
   */
  async gatedWriteTest(capability: CapabilityName, accountId: string): Promise<WriteOutcome> {
    return this.gatedWrite(capability, accountId, async () => true);
  }

  /** Non-secret status for the UI. */
  policyStatus() {
    return {
      provider: 'propdao',
      capabilities: PROPDAO_CAPABILITIES,
      ...executionPolicyStatus(this.env()),
      apiBaseConfigured: Boolean(this.env().PROPDAO_API_BASE_URL?.trim()),
    };
  }
}

function emptyRisk(accountId: string, reason: string): AccountRiskSnapshot {
  return {
    accountId,
    equity: null,
    balance: null,
    floorUsd: null,
    floorKind: null,
    roomUsd: null,
    roomPct: null,
    breached: null,
    openPositions: null,
    incomplete: true,
  };
}

/** Re-exported so callers can build the audit line without importing two modules. */
export { redactText, PropDaoError };