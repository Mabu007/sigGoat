import { TradingSkill } from '../types';

export const DEFAULT_SKILLS: TradingSkill[] = [
  {
    id: 'skill_price_action',
    userId: 'system',
    name: 'Price Action',
    description: 'Naked candlestick dynamics, swing structure, higher highs, and lower lows without lagging indicators.',
    methodology: 'Analyze pure order flow through candlestick body-to-wick ratios, market structure shifts (MSS), and clean supply/demand reactions.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, Disregard lagging momentum oscillators.',
    preferredTimeframes: ['15m', '1h', '4h'],
    requiredEvidence: 'Clean structural break of previous swing high/low; candlestick rejection with wick > 50% of range.',
    invalidationRules: 'Close beyond initiation swing point invalidates the price action setup immediately.',
    rawMarkdown: `---
id: skill_price_action
name: Price Action
timeframes: 15m, 1h, 4h
---

# Price Action

Analyze pure order flow through candlestick body-to-wick ratios, market structure shifts (MSS), and clean supply/demand reactions.

## Thesis Formation
- Require evidence of clean swing structure (higher highs and higher lows for bullish thesis; lower highs and lower lows for bearish thesis).
- Look for price rejecting established demand or supply areas with clear rejection wicks.

## Event Interpretation
- Distinguish between structural breaks and mere liquidity taps.
- A decisive candle close outside the prior swing confirms shift in market bias.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
LIMIT_ORDERS_ONLY

## Invalidation Rules
Close beyond the initiation swing point invalidates the price action setup immediately.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'skill_liquidity_sweeps',
    userId: 'system',
    name: 'Liquidity Sweep Analysis',
    description: 'Institutional stop-run detection above previous highs and below previous lows before swift reversals.',
    methodology: 'Identify resting liquidity pools (equal highs, equal lows, previous day highs/lows). Wait for price to puncture the liquidity pool and swiftly re-enter the prior range.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, NEVER_ENTER_INITIAL_EXPANSION_BAR',
    preferredTimeframes: ['5m', '15m', '1h'],
    requiredEvidence: 'Puncture of liquidity level by at least 3-10 pips followed by candle close back inside the prior range.',
    invalidationRules: 'Sustained acceptance and multiple closes outside the swept level indicating a genuine expansion rather than a sweep.',
    rawMarkdown: `---
id: skill_liquidity_sweeps
name: Liquidity Sweep Analysis
timeframes: 5m, 15m, 1h
---

# Liquidity Sweep Analysis

Identify resting liquidity pools above prior highs and below prior lows. Institutional market participants frequently trigger stop clusters before initiating the true directional drive.

## Thesis Formation
- Identify clean swing highs or swing lows with obvious retail stop orders resting outside.
- Look for swift displacement that punches through the level without lingering.

## Event Interpretation
- Price must wick outside the liquidity boundary and close back inside the range.
- Rapid re-entry confirms liquidity absorption.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
WAIT_FOR_REJECTION_CONFIRMATION

## Invalidation Rules
Sustained acceptance and candle closes outside the swept pool invalidate the sweep thesis.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'skill_london_session',
    userId: 'system',
    name: 'London Session Strategy',
    description: 'Capitalizes on the London open expansion and Judas swing manipulation between 07:00 and 10:30 UTC.',
    methodology: 'Map Asian range high and low (00:00-06:00 UTC). Look for London open to manipulate the Asian extreme before reversing into the true daily direction.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, LONDON_OPEN_WINDOW_ONLY',
    preferredTimeframes: ['15m', '1h'],
    requiredEvidence: 'False break of Asian session extreme occurring during the first 90 minutes of the London open.',
    invalidationRules: 'Failure to establish directional displacement within 2 hours of London open.',
    rawMarkdown: `---
id: skill_london_session
name: London Session Strategy
timeframes: 15m, 1h
---

# London Session Strategy

Capitalize on the London open liquidity surge (07:00 - 10:30 UTC). The Asian session typically consolidates, providing clean boundaries that London manipulates before expanding.

## Thesis Formation
- Map Asian session range high and low (00:00 - 06:00 UTC).
- Watch for early London probe below Asian low (bullish bias setup) or above Asian high (bearish bias setup).

## Event Interpretation
- If London breaks Asian extreme and swiftly rejects back into range, form a conditional mean-expansion thesis toward opposite session extreme.
- Condition trade entry on retracement to the breakout origin point.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
WAIT_FOR_SESSION_OPEN_CONFIRMATION

## Invalidation Rules
Failure to establish directional displacement within 2 hours of London open or market remaining flat in Asian consolidation.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'skill_breakout_detection',
    userId: 'system',
    name: 'Breakout Detection',
    description: 'Volatility expansion confirmation out of compression regimes with volume and spread verification.',
    methodology: 'Identify consolidation ranges where spread is low and volatility compressed. Trigger investigation upon high-momentum candle piercing range boundary.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, SPREAD_UNDER_2_PIPS',
    preferredTimeframes: ['15m', '1h', '4h'],
    requiredEvidence: 'Candle close outside range by at least 1x ATR accompanied by volume expansion.',
    invalidationRules: 'Re-entry into the center 50% of the consolidation channel within two periods.',
    rawMarkdown: `---
id: skill_breakout_detection
name: Breakout Detection
timeframes: 15m, 1h, 4h
---

# Breakout Detection

Look for volatility expansion breaking out of multi-hour consolidation regimes.

## Thesis Formation
- Identify clear horizontal channel boundaries with contracted ATR.
- Formulate directional expansion thesis only when a full candle body closes outside the channel.

## Event Interpretation
- Avoid chasing the initial impulse. Instead, plan a conditional retest order at the broken boundary.
- Volume must validate participation.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
LIMIT_ORDERS_ONLY

## Invalidation Rules
Price sliding back into the midpoint of the prior consolidation zone.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'skill_trend_following',
    userId: 'system',
    name: 'Trend Following & Pullbacks',
    description: 'Disciplined trend continuation entries on shallow retests of moving structure.',
    methodology: 'Establish macro trend direction on 4h timeframe. Look for lower-timeframe shallow pullbacks to broken support/resistance.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, NO_COUNTER_TREND',
    preferredTimeframes: ['1h', '4h', '1d'],
    requiredEvidence: 'Higher highs and higher lows structure; pullback bounces from prior resistance turned support.',
    invalidationRules: 'Lower low broken on intermediate timeframe, signaling structural trend break.',
    rawMarkdown: `---
id: skill_trend_following
name: Trend Following & Pullbacks
timeframes: 1h, 4h, 1d
---

# Trend Following & Pullbacks

Disciplined trend continuation entries on shallow retests of moving structural zones.

## Thesis Formation
- Establish macro structural trend on the 4h timeframe.
- In an uptrend, identify prior swing high resistance that has been broken; plan a buy limit on pullback retest.
- In a downtrend, identify prior swing low support broken; plan a sell limit on pullback retest.

## Event Interpretation
- Pullback must show deceleration candles rather than sharp counter-trend impulses.
- Invalidation lies just beyond the preceding swing anchor.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
MINIMUM_RR_2_TO_1

## Invalidation Rules
Lower low broken on intermediate timeframe, signaling structural trend exhaustion.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'skill_mean_reversion',
    userId: 'system',
    name: 'Mean Reversion',
    description: 'Fades extended moves back toward a statistical mean, only when the extension is objectively measurable.',
    methodology: 'Define the mean (session VWAP proxy or 20-period SMA) and the extension threshold from ATR. Enter only when price has stretched a defined multiple of ATR away from the mean AND shows rejection evidence. Fade back toward the mean, never into an active expansion.',
    constraints: 'REQUIRE_INVALIDATION_BEFORE_TRADE, REQUIRE_EVIDENCE_BEFORE_ACTIONABLE, LIMIT_ORDERS_ONLY',
    preferredTimeframes: ['15m', '1h'],
    requiredEvidence: 'Price extended at least 1.5x ATR(14) from the 20-SMA, plus a rejection candle closing back toward the mean.',
    invalidationRules: 'A close beyond the extension extreme, or the mean itself breaking (structure shift), invalidates the reversion thesis.',
    rawMarkdown: `---
id: skill_mean_reversion
name: Mean Reversion
timeframes: 15m, 1h
---

# Mean Reversion

Fade measurable extensions back toward the statistical mean.

## Thesis Formation
- Establish the mean: 20-period SMA on the tracking timeframe.
- Measure extension in ATR units; require at least 1.5x ATR(14).
- Only fade when a rejection candle closes back toward the mean.

## Event Interpretation
- Treat a fresh breakout with displacement as expansion, NOT extension.
- The reversion target is the mean; do not hold through a structure break.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
LIMIT_ORDERS_ONLY

## Invalidation Rules
Close beyond the extension extreme, or the mean breaking with displacement.
`,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
