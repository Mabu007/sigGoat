import { FundGoat } from '../types';
import { SYSTEM_SKILL_IDS } from './systemSkills';

/**
 * SYSTEM-OWNED GOAT TEMPLATES
 * ===========================
 * Example monitoring setups a user can copy into their workspace.
 *
 * WHY TEMPLATES AND NOT "CREATE IT FOR ME"
 *
 * A GOAT here is a DEFINITION: markets, goal, skill set, schedule and tracking
 * cadence. Nothing is deployed and no market data is fetched until the user
 * copies one and it goes through the ordinary create path. That keeps templates
 * free of side effects and means a template can never spend a user's credits.
 *
 * EVERY FIELD IS VALIDATED BY THE EXISTING SCHEMA
 *
 * `markets` are drawn from the same instrument list the server accepts, and
 * `skillIds` reference the catalogue in `systemSkills.ts`. There is no free-form
 * configuration, and no executable content of any kind: a GOAT carries strings
 * and enums.
 *
 * NO PERFORMANCE CLAIMS
 *
 * Names and descriptions state what a GOAT WATCHES FOR. None asserts an accuracy
 * rate, a win rate or a return, because none has been measured and these
 * definitions have not been backtested.
 */

const SYSTEM_USER = 'system';

/**
 * Markets the runtime accepts, matching the feed's own symbol list.
 *
 * These are the provider's VENUE identifiers, verified against the live
 * Hyperliquid catalogue. Conventional pairs (`EUR/USD`, `XAU/USD`, `US500`,
 * `WTI`) are NOT listed by this venue, and a template referencing one would
 * create a GOAT that can never fetch data.
 */
const MARKETS = {
  majors: ['BTC', 'ETH', 'SOL'],
  currencies: ['xyz:EUR', 'xyz:GBP'],
  metals: ['xyz:GOLD'],
  index: ['xyz:JP225', 'xyz:KR200'],
  energy: ['xyz:CL'],
} as const;

function template(
  t: Omit<FundGoat, 'userId' | 'status' | 'createdAt' | 'updatedAt'>,
): FundGoat {
  return {
    ...t,
    userId: SYSTEM_USER,
    // Templates are never deployed in place; copying produces a WATCHING GOAT.
    status: 'PAUSED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export const SYSTEM_GOATS: FundGoat[] = [
  template({
    id: 'tmpl_session_sweep_fx',
    name: 'Session Sweep Watcher',
    goal:
      'Watch the most liquid crypto majors for liquidity sweeps at the London and New York session opens, and only raise a setup once the swept level has been reclaimed.',
    markets: [...MARKETS.majors],
    skillIds: ['skill_session_liquidity', 'skill_risk_validated_setup'],
    model: 'openai/gpt-4o-mini',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '15m',
  }),

  template({
    id: 'tmpl_multi_timeframe_index',
    name: 'Multi-Timeframe Index Confirmation',
    goal:
      'Track the major indices for a structural break on the tracking timeframe that agrees with the higher-timeframe bias, and wait rather than lean into disagreement.',
    markets: [...MARKETS.index],
    skillIds: ['skill_multi_timeframe_confirmation', 'skill_volatility_regime'],
    model: 'openai/gpt-4o-mini',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '15m',
  }),

  template({
    id: 'tmpl_gold_volatility',
    name: 'Gold Volatility Monitor',
    goal:
      'Observe gold (venue symbol xyz:GOLD) across volatility regimes, treating compressed ranges as requiring a larger confirmed break rather than a noise candle.',
    markets: [...MARKETS.metals],
    skillIds: ['skill_volatility_regime', 'skill_event_driven_tracking'],
    model: 'openai/gpt-4o-mini',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '5m',
  }),

  template({
    id: 'tmpl_conservative_breakout',
    name: 'Conservative Breakout Watcher',
    goal:
      'A deliberately selective setup: require every listed confirmation condition to hold before proposing anything, and treat NO_TRADE as the expected outcome in most runs.',
    markets: [...MARKETS.majors, ...MARKETS.index],
    skillIds: ['skill_no_trade_discipline', 'skill_risk_validated_setup'],
    model: 'openai/gpt-4o-mini',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '15m',
  }),

  template({
    id: 'tmpl_energy_session',
    name: 'Crude Session Ranges',
    goal:
      'Watch crude oil (venue symbol xyz:CL) for movement between the prior session range and a level it is retested from, judged against the volatility regime in force.',
    markets: [...MARKETS.energy],
    skillIds: ['skill_session_liquidity', 'skill_multi_timeframe_confirmation'],
    model: 'openai/gpt-4o-mini',
    schedule: { mode: 'TRACKERS', intervalMinutes: 60 },
    timeframe: '15m',
  }),
];

export const SYSTEM_GOAT_IDS = new Set(SYSTEM_GOATS.map((g) => g.id));

export function isSystemGoatId(id: string): boolean {
  return SYSTEM_GOAT_IDS.has(id);
}

/**
 * Every template references only catalogue skills.
 *
 * Checked rather than assumed, because a template pointing at a skill that does
 * not exist would produce a GOAT the user cannot actually run.
 */
export function templateSkillRefsResolve(): boolean {
  return SYSTEM_GOATS.every((goat) =>
    goat.skillIds.every((id) => SYSTEM_SKILL_IDS.has(id)),
  );
}