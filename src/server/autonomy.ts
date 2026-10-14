/**
 * AUTONOMOUS ACCEPTANCE
 * =====================
 * What "full autonomy" actually means in this app, in one place.
 *
 * THE DISTINCTION THAT MATTERS
 *
 *   PROPOSAL mode   — a GOAT that produces a setup writes a proposal and
 *                     STOPS. Nothing is accepted until the user accepts it.
 *   AUTONOMOUS mode — the same setup, from the same signal gate, but the
 *                     accept step is taken by the system instead of the user.
 *
 * The two modes therefore differ in EXACTLY ONE place: who records
 * `decision: 'ACCEPTED'`. Full autonomy never means "skip the risk checks" —
 * `SignalGate` produced this signal before this function was ever called, and
 * `PropRiskValidator` plus the PropDAO execution policy still sit downstream
 * of any order. It only means "do not stop to ask".
 *
 * HONESTY ABOUT EXECUTION
 *
 * Accepting a proposal is a DECISION RECORD, not an order. Venue execution is
 * a separate, separately-gated capability (`PROPDAO_EXECUTION_ENABLED`, off
 * by default) and is not reachable from this function. So `autoAcceptSignal`
 * reports the policy it found and stops, rather than implying an order was
 * placed. Anything else would be the worst possible failure for a feature
 * whose entire name is a promise that money moves on its own.
 */

import type { AutonomyMode, FundGoat, TradeSignal, UserProfile } from '../types';
import { normaliseAutonomyMode } from '../types';

export type AutonomousOutcome =
  /** The user is in PROPOSAL mode. Nothing was decided. */
  | { action: 'SKIPPED_PROPOSAL_MODE'; autonomyMode: AutonomyMode }
  /** Not an actionable setup, or already finalised. */
  | { action: 'SKIPPED_NOT_ACTIONABLE'; reason: string }
  /** Recorded as accepted; the execution policy is reported alongside it. */
  | {
      action: 'AUTO_ACCEPTED';
      signal: TradeSignal;
      execution: { enabled: boolean; authorised: boolean; summary: string };
    }
  /** Something failed. The signal is left undecided so the user still sees it. */
  | { action: 'FAILED'; reason: string };

export interface AutonomousPersistence {
  signals: {
    update(signal: TradeSignal): Promise<boolean>;
  };
  profiles: {
    get(userId: string): Promise<UserProfile | null>;
  };
}

export interface AutonomousExecutionPolicy {
  enabled: boolean;
  authorised: boolean;
  summary: string;
  termsSummary: string;
}

/**
 * Records the automatic acceptance of one approved signal.
 *
 * A pure function of its inputs plus two injected collaborators: this is the
 * most consequential branch in the product, so it must be testable without a
 * server, a database or a network, and reachable from nowhere except the
 * signal pipeline that has already run the gate.
 */
export async function autoAcceptSignal(
  deps: {
    persistence: AutonomousPersistence;
    policyStatus: () => AutonomousExecutionPolicy;
    executeSignal?: (goat: FundGoat, signal: TradeSignal, profile: UserProfile) => Promise<{ submitted: boolean; orderId?: string | null; intentId?: string; message?: string }>;
  },
  goat: FundGoat,
  signal: TradeSignal,
  now: () => number = Date.now,
): Promise<AutonomousOutcome> {
  const profile = await deps.persistence.profiles
    .get(goat.userId)
    .catch(() => null);
  const autonomyMode = normaliseAutonomyMode(profile?.autonomyMode);

  if (autonomyMode !== 'AUTONOMOUS') {
    return { action: 'SKIPPED_PROPOSAL_MODE', autonomyMode };
  }

  if (signal.decision) {
    return {
      action: 'SKIPPED_NOT_ACTIONABLE',
      reason: `already ${signal.decision.toLowerCase()}`,
    };
  }

  if (signal.status !== 'ACTIONABLE') {
    return {
      action: 'SKIPPED_NOT_ACTIONABLE',
      reason: `signal status is ${signal.status}`,
    };
  }

  if (signal.direction === 'NO_TRADE') {
    return { action: 'SKIPPED_NOT_ACTIONABLE', reason: 'NO_TRADE signal' };
  }

  if (signal.expiresAt && Date.parse(signal.expiresAt) < now()) {
    return { action: 'SKIPPED_NOT_ACTIONABLE', reason: 'signal expired' };
  }

  let order: { submitted: boolean; orderId?: string | null; intentId?: string; message?: string } | undefined;
  if (profile?.autoTradeEnabled) {
    if (!deps.executeSignal) return { action: "FAILED", reason: "Auto-trading is enabled but no execution handler is configured." };
    try {
      order = await deps.executeSignal(goat, signal, profile);
    } catch (error) {
      return { action: "FAILED", reason: error instanceof Error ? error.message : "Automatic order submission failed." };
    }
    if (!order.submitted) return { action: "FAILED", reason: order.message ?? "Automatic order submission was blocked. The proposal remains undecided." };
  }

  const stamp = new Date(now()).toISOString();
  const decided: TradeSignal = {
    ...signal,
    decision: 'ACCEPTED',
    decidedAt: stamp,
    /**
     * The audit trail has to say WHY there was no human in the loop. A record
     * indistinguishable from a clicked Accept cannot be reviewed afterwards.
     */
    decisionNote: profile?.autoTradeEnabled
      ? `Auto-accepted and PropDAO order submitted (${order?.orderId ?? order?.intentId ?? 'provider confirmation received'}).`
      : 'Auto-accepted: autonomy mode is on; no venue order was requested.',
    updatedAt: stamp,
  };

  const persisted = await deps.persistence.signals.update(decided);
  if (!persisted) {
    return { action: 'FAILED', reason: 'signal no longer exists' };
  }

  const policy = deps.policyStatus();
  return {
    action: 'AUTO_ACCEPTED',
    signal: decided,
    execution: {
      enabled: policy.enabled,
      authorised: policy.authorised,
      summary: `${policy.summary} ${policy.termsSummary}`.trim(),
    },
  };
}
