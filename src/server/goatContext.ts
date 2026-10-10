/**
 * CANONICAL GOAT CONTEXT BUILDER
 * ================================
 * One function that assembles the full reasoning/chat context for a GOAT.
 * Web chat, Telegram, and any future interface consume the SAME
 * representation — no second, subtly different context type.
 */

import { GoatReasoningContext } from '../services/ai/OpenRouterClient';
import { calculateEMA, calculateRSI, calculateATR, analyzeMarketStructure } from '../services/tracker-sdk/indicators';
import { MarketDataProvider } from '../services/market-data/MarketDataProvider';
import { TradingSkill } from '../types';
import { GoatRepository, SkillRepository, NotFoundError } from './repositories';

export interface GoatContextDeps {
  goats: GoatRepository;
  skills: SkillRepository;
  marketProvider: MarketDataProvider;
}

export async function buildGoatContext(
  deps: GoatContextDeps,
  goatId: string,
  userId: string,
): Promise<{ context: GoatReasoningContext; goatName: string; goatGoal: string; model: string; markets: string[] }> {
  const goat = await deps.goats.getForUser(goatId, userId);
  if (!goat) {
    throw new NotFoundError('GOAT not found');
  }

  const allSkills = await deps.skills.listByUser(goat.userId);
  const attachedSkills: TradingSkill[] = goat.skillIds
    .map((id) => allSkills.find((s) => s.id === id))
    .filter((s): s is TradingSkill => Boolean(s));

  /**
   * No hardcoded fallback market. If a GOAT has no markets, there is nothing
   * safe to quote — a stale conventional pair (e.g. US500) is not a market
   * this venue lists, and requesting it would degrade the shared store, so the
   * GOAT must have at least one configured market.
   */
  const market = goat.markets[0] ?? '';
  if (!market) {
    throw new NotFoundError('GOAT has no market configured');
  }

  const [quote, candles] = await Promise.all([
    deps.marketProvider
      .getQuote(market)
      .catch((err) => {
        console.warn(`[goat-context] quote for ${market} unavailable:`, err);
        return undefined;
      }),
    deps.marketProvider
      .getCandles(market, '1h', 35)
      .catch((err) => {
        console.warn(`[goat-context] candles for ${market} unavailable:`, err);
        return [];
      }),
  ]);

  const struct = analyzeMarketStructure(candles, quote?.mid ?? 0);
  const deterministicIndicators = {
    rsi14: calculateRSI(candles, 14),
    ema20: calculateEMA(candles, 20),
    ema50: calculateEMA(candles, 50),
    atr14: calculateATR(candles, 14),
    structureBias: struct.bias,
    demandZone: struct.demandZone,
    supplyZone: struct.supplyZone,
  };

  const context: GoatReasoningContext = {
    userId: goat.userId,
    goatId: goat.id,
    goatName: goat.name,
    goatGoal: goat.goal,
    market,
    quote,
    candles,
    skills: attachedSkills,
    activeThesis: null,
    wakeReason: undefined,
    reviewSession: undefined,
    deterministicIndicators,
    dataSource: deps.marketProvider.dataMode,
  };

  return {
    context,
    goatName: goat.name,
    goatGoal: goat.goal,
    model: goat.model,
    markets: goat.markets,
  };
}
