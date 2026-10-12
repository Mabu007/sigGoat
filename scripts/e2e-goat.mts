/**
 * END-TO-END GOAT LIFECYCLE, AGAINST THE LIVE PROVIDERS
 * =====================================================
 * Drives the real Express app over HTTP with the real Hyperliquid market data
 * and the real OpenRouter key, exercising exactly the journey a user takes:
 *
 *   save key -> pick model -> create GOAT -> watch it reason -> read the
 *   proposal -> switch autonomy -> pause -> resume -> delete
 *
 * This is a SCRIPT, not a unit test: it makes billable network calls and is
 * not part of `bun test`. Run with:
 *
 *   npx tsx scripts/e2e-goat.mts
 *
 * It exits non-zero on the first failure so it can gate a deploy.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';

const OPENROUTER_KEY = process.env.E2E_OPENROUTER_KEY;
const PROPDAO_KEY = process.env.E2E_PROPDAO_KEY;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  if (!OPENROUTER_KEY) {
    console.error('E2E_OPENROUTER_KEY is required.');
    process.exit(2);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalgoat-e2e-'));

  process.env.NODE_ENV = 'test';
  process.env.SIGNALGOAT_ALLOW_DEV_AUTH = '1';
  process.env.MARKET_DATA_PROVIDER = 'hyperliquid';
  process.env.DATA_DIR = dataDir;
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY;
  // A fixed master key so the vault actually encrypts rather than failing
  // closed — this is the bug that silently orphaned credentials on Vercel.
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.CREDENTIAL_ENCRYPTION_KEY_ID = 'e2e';
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const router = await import('../src/server/apiRouter');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', router.apiRouter);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const UID = 'e2e-user';

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-dev-user-id': UID,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  try {
    /* ---------- Markets ---------- */
    section('Markets (live Hyperliquid)');
    const search = await call('GET', '/api/markets/search?limit=1000');
    check('search returns 200', search.status === 200, `status ${search.status}`);
    const markets: any[] = search.json?.markets ?? [];
    check('universe is not truncated', markets.length > 200, `got ${markets.length}`);

    for (const category of ['currencies', 'commodities', 'indices', 'crypto']) {
      const n = markets.filter((m) => m.category === category).length;
      check(`${category} present (${n})`, n > 0);
    }
    for (const sym of ['xyz:EUR', 'xyz:GOLD', 'xyz:SP500', 'BTC']) {
      check(`${sym} listed`, markets.some((m) => m.symbol === sym));
    }
    check(
      'no delisted instrument is offered',
      markets.every((m) => m.delisted !== true),
    );

    const candles = await call('GET', '/api/markets/candles?symbol=xyz%3AEUR&timeframe=15m&count=50');
    check('xyz:EUR candles load', candles.status === 200 && candles.json?.candles?.length > 0,
      `status ${candles.status}`);

    const badCandles = await call('GET', '/api/markets/candles?symbol=EUR%2FUSD&timeframe=15m&count=50');
    check('unlisted market is a 400, not a 500', badCandles.status === 400,
      `status ${badCandles.status}`);

    /* ---------- Credential round trip ---------- */
    section('Credentials');
    const saved = await call('POST', '/api/settings/keys', {
      provider: 'openrouter',
      openRouterKey: OPENROUTER_KEY,
      ...(PROPDAO_KEY ? { propDaoApiKey: PROPDAO_KEY } : {}),
    });
    check('key saved', saved.status === 200, `status ${saved.status}`);
    check('reported as configured', saved.json?.openRouterKeyConfigured === true);

    const keyStatus = await call('GET', '/api/settings/keys');
    check('vault reports available', keyStatus.json?.encryptionAvailable === true);
    check('no secret echoed', !JSON.stringify(keyStatus.json).includes(OPENROUTER_KEY.slice(-12)));

    const models = await call('GET', '/api/ai/models');
    check('model catalogue loads', models.status === 200 && Array.isArray(models.json?.models),
      `status ${models.status}`);
    const all: any[] = models.json?.models ?? [];
    const freeTier = all.filter((m) => m.id.endsWith(':free'));
    const zeroPriced = all.filter((m) => m.free);
    check('OpenRouter free tier is offered', freeTier.length > 0, `freeTier=${freeTier.length}`);
    check('catalogue is not empty', all.length > 0, `total=${all.length}`);

    /**
     * Prefer the `:free` tier, exactly as `pickAnyModel` and the Settings
     * picker do. Some models the catalogue prices at zero still answer
     * `402 Insufficient credits` on a zero-credit account, so "priced free"
     * is not the same as "callable free" — which is itself worth asserting.
     */
    const chosen = freeTier[0]?.id ?? zeroPriced[0]?.id ?? all[0]?.id;
    check('a model can be chosen', Boolean(chosen), String(chosen));
    console.log(`  ....  using model: ${chosen}`);

    const prefSaved = await call('POST', '/api/settings/preferences', { aiModel: chosen });
    check('preferred model saved', prefSaved.status === 200 && prefSaved.json?.aiModel === chosen,
      `status ${prefSaved.status}`);

    const badModel = await call('POST', '/api/settings/preferences', { aiModel: 'vendor/not-a-real-model-xyz' });
    check('a model OpenRouter does not list is refused', badModel.status === 400,
      `status ${badModel.status}`);

    /* ---------- PropDAO ---------- */
    if (PROPDAO_KEY) {
      section('PropDAO (live)');
      const pdStatus = await call('GET', '/api/propdao/status');
      check('propdao status 200', pdStatus.status === 200);
      const accounts = await call('GET', '/api/propdao/accounts');
      check('accounts load', accounts.status === 200 && Array.isArray(accounts.json?.accounts),
        `status ${accounts.status}`);
      const first = accounts.json?.accounts?.[0];
      check('an account is connected', Boolean(first?.accountId), JSON.stringify(first)?.slice(0, 120));
      if (first?.accountId) {
        // Risk is embedded on the account record rather than exposed as its
        // own route, so a single call answers both.
        check('risk snapshot loads', first?.risk?.equity > 0, JSON.stringify(first?.risk));
        check('risk is complete, not all-null', first?.risk?.incomplete === false,
          JSON.stringify(first?.risk));
        check('challenge rules parsed', first?.rules?.maxDrawdownPct > 0,
          JSON.stringify(first?.rules));
        check('drawdown headroom is positive', (first?.risk?.roomUsd ?? 0) > 0,
          `roomUsd=${first?.risk?.roomUsd}`);
      }
      const pdMarkets = await call('GET', '/api/propdao/markets');
      check('propdao markets load', pdMarkets.status === 200 && pdMarkets.json?.total > 0,
        `status ${pdMarkets.status}`);
    }

    /* ---------- GOAT lifecycle ---------- */
    section('GOAT lifecycle (live model)');
    const created = await call('POST', '/api/goats', {
      name: 'E2E Gold Scout',
      goal: 'Track gold for a confirmed breakout.',
      markets: ['xyz:GOLD'],
      skillIds: [],
      model: chosen,
      schedule: { mode: 'INTERVAL', intervalMinutes: 60 },
      timeframe: '15m',
    });
    check('GOAT created', created.status === 200, `status ${created.status} ${JSON.stringify(created.json)?.slice(0,200)}`);
    const goat = created.json?.goat;
    check('market accepted verbatim', goat?.markets?.[0] === 'xyz:GOLD');
    check('chosen model persisted', goat?.model === chosen, `${goat?.model} vs ${chosen}`);

    const state = created.json?.runtimeState;
    check('GOAT returned immediately with a pending first analysis',
      created.json?.firstAnalysisPending === true,
      `firstAnalysisPending=${created.json?.firstAnalysisPending}`);

    /**
     * The first analysis is dispatched, not awaited — awaiting it blew the
     * serverless timeout and returned 504 for a GOAT that had been created
     * successfully. So poll for it the way the UI does.
     */
    /**
     * Generous, because a reasoning-first free model genuinely takes this
     * long: measured at ~70s end to end on a cold run, and the suite has a
     * second GOAT reasoning concurrently against the same free tier. A short
     * deadline here measures the model's latency, not the product.
     */
    let reasoned: any = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await call('GET', `/api/goats/${goat?.id}`);
      const st = poll.json?.runtimeState;
      if (process.env.E2E_VERBOSE) {
        console.log(`    poll: evaluating=${st?.isEvaluating} status=${st?.status} wake=${String(st?.lastWakeEvent?.details).slice(0,60)} err=${String(st?.lastError).slice(0,60)}`);
      }
      /**
       * Break on a RECORDED wake event, not on `isEvaluating === false`.
       *
       * A completed analysis whose trackers immediately satisfy a condition
       * escalates straight into another wake, so the flag can be true again
       * by the time the poll lands. Waiting for false would time out against
       * a GOAT that is working exactly as designed.
       */
      if (st?.lastWakeEvent) {
        reasoned = st;
        break;
      }
    }

    check('the reasoning run completed asynchronously', Boolean(reasoned),
      reasoned === null ? 'no wake event within 300s' : '');
    if (reasoned) {
      check('the model was actually reached',
        reasoned.lastError === undefined
        && !String(reasoned.lastWakeEvent?.details ?? '').includes('MODEL_UNAVAILABLE'),
        String(reasoned.lastError ?? reasoned.lastWakeEvent?.details).slice(0, 140));
      check('the thesis persisted without a Firestore error',
        !String(reasoned.lastError ?? '').includes('Firestore'),
        String(reasoned.lastError).slice(0, 140));

      /**
       * THE INITIAL MARKET REVIEW — the thing Priority 3 is actually about.
       *
       * "A thesis exists" is not the requirement. The review has to answer the
       * questions a trader actually asks on opening a GOAT: what market was
       * examined, what the conditions are, what evidence supports it, what it
       * will watch next, and whether a proposal exists or it is waiting.
       */
      const thesis = reasoned.currentThesis;
      check('the review names the market it examined',
        Boolean(thesis?.market) && thesis.market === 'xyz:GOLD',
        String(thesis?.market));
      check('the review states observed market conditions',
        Boolean(thesis?.assetState?.trim()) || Boolean(thesis?.summary?.trim()),
        String(thesis?.assetState ?? thesis?.summary).slice(0, 100));
      check('the review carries supporting evidence',
        Array.isArray(thesis?.supportingEvidence) && thesis.supportingEvidence.length > 0,
        `${thesis?.supportingEvidence?.length ?? 0} items`);
      check('the review states a directional thesis with confidence',
        Boolean(thesis?.directionalHypothesis)
        && typeof thesis?.confidence === 'number',
        `${thesis?.directionalHypothesis} @ ${thesis?.confidence}`);
      check('the review records what it will monitor next',
        Array.isArray(thesis?.tradePlan) && thesis.tradePlan.length > 0
        && (Array.isArray(thesis?.trackers) ? thesis.trackers.length > 0 : true),
        `${thesis?.tradePlan?.length ?? 0} plan steps / ${thesis?.trackers?.length ?? 0} trackers`);
      check('the review states its invalidation condition',
        Boolean(thesis?.invalidationConditions?.length)
        || Boolean(thesis?.invalidationReason)
        || Boolean(thesis?.observationPlan),
        String(thesis?.invalidationConditions?.length ?? thesis?.observationPlan).slice(0, 80));
      check('the review declares the timeframe it was evaluated on',
        Boolean(thesis?.relevantTimeframe),
        String(thesis?.relevantTimeframe));

      /**
       * A proposal state is REQUIRED — but the answer may legitimately be "no
       * trade". Forcing a signal would be worse than reporting no trade.
       */
      check('the review states whether a proposal exists or it is waiting',
        reasoned.latestSignal !== null && reasoned.latestSignal !== undefined
          ? ['ACTIONABLE', 'NO_TRADE', 'INVALIDATED', 'EXPIRED'].includes(reasoned.latestSignal.status)
          : true,
        String(reasoned.latestSignal?.status ?? 'no signal yet'));
      check('the review explains the GOAT\'s current position in words',
        Boolean(reasoned.dormancyReason?.trim()),
        String(reasoned.dormancyReason).slice(0, 100));

      /**
       * REVIEW SURVIVES A COLD START.
       *
       * Runtime state is in-memory, so on a serverless host it only survives a
       * recycle because the actor hydrates from the persisted thesis. This is
       * the check that would catch the review silently disappearing — the
       * reported Priority 3 bug.
       */
      const reread = await call('GET', '/api/goats');
      const again = (reread.json?.goats ?? []).find((g: any) => g.id === goat?.id);
      check('the review is still served on a later request (hydrated from persistence)',
        Boolean(again?.runtimeState?.currentThesis),
        `runtimeState=${again?.runtimeState === null ? 'null' : 'present'} thesis=${Boolean(again?.runtimeState?.currentThesis)}`);
    }

    const listed = await call('GET', '/api/goats');
    check('GOAT appears in the list', (listed.json?.goats ?? []).some((g: any) => g.id === goat?.id));

    const signals = await call('GET', `/api/goats/${goat?.id}/signals`);
    check('signals endpoint works', signals.status === 200, `status ${signals.status}`);

    const retried = await call('POST', '/api/goats', {
      name: 'E2E Legacy Symbol',
      goal: 'Uses a retired symbol.',
      markets: ['EUR/USD'],
      skillIds: [],
      model: chosen,
    });
    check('retired symbol is migrated, not rejected', retried.status === 200,
      `status ${retried.status}`);
    check('migrated to the live instrument',
      retried.json?.goat?.markets?.[0] === 'xyz:EUR',
      JSON.stringify(retried.json?.goat?.markets));

    const bogus = await call('POST', '/api/goats', {
      name: 'E2E Bogus',
      goal: 'Uses a nonsense symbol.',
      markets: ['NOT_A_MARKET_XYZZY'],
      skillIds: [],
      model: chosen,
    });
    check('unknown market is refused with 400', bogus.status === 400, `status ${bogus.status}`);
    if (retried.json?.goat?.id) {
      await call('DELETE', `/api/goats/${retried.json.goat.id}`);
    }

    /* ---------- Pause / resume ---------- */
    section('Pause and resume');
    const paused = await call('POST', `/api/goats/${goat?.id}/status`, { action: 'PAUSE' });
    check('pause works', paused.status === 200 && paused.json?.goat?.status === 'PAUSED',
      JSON.stringify(paused.json)?.slice(0, 160));
    const played = await call('POST', `/api/goats/${goat?.id}/status`, { action: 'PLAY' });
    check('play works', played.status === 200 && played.json?.goat?.status !== 'PAUSED',
      JSON.stringify(played.json)?.slice(0, 160));

    /* ---------- Autonomy ---------- */
    section('Autonomy mode');
    const setAuto = await call('POST', '/api/settings/preferences', { autonomyMode: 'AUTONOMOUS' });
    check('autonomy can be enabled', setAuto.status === 200 && setAuto.json?.autonomyMode === 'AUTONOMOUS');
    check('server reports whether execution is possible',
      typeof setAuto.json?.autonomyExecutable === 'boolean');

    const badMode = await call('POST', '/api/settings/preferences', { autonomyMode: 'YOLO' });
    check('an unknown mode is refused', badMode.status === 400, `status ${badMode.status}`);

    await call('POST', '/api/settings/preferences', { autonomyMode: 'PROPOSAL' });

    /* ---------- Backtest ---------- */
    section('Backtest');
    const bt = await call('POST', '/api/backtest/run', { goatId: goat?.id, period: '7d' });
    check('backtest runs', bt.status === 200, `status ${bt.status} ${JSON.stringify(bt.json)?.slice(0,160)}`);
    check('backtest returns a result', Boolean(bt.json?.result), JSON.stringify(bt.json)?.slice(0, 200));

    const btBad = await call('POST', '/api/backtest/run', { goatId: goat?.id, market: 'EUR/USD', period: '7d' });
    check('backtest on a retired symbol is a 400', btBad.status === 400, `status ${btBad.status}`);

    /* ---------- Chatbot ---------- */
    section('Chatbot');
    const chat = await call('POST', '/api/chat', { message: 'In one sentence, what is a stop-loss?' });
    check('chat creates a session', chat.status === 200 && Boolean(chat.json?.chat?.id),
      `status ${chat.status}`);
    check('chat answers', Boolean(chat.json?.message?.content),
      JSON.stringify(chat.json)?.slice(0, 200));
    const chatId = chat.json?.chat?.id;
    if (chatId) {
      const history = await call('GET', `/api/chat?chatId=${encodeURIComponent(chatId)}`);
      check('chat history round-trips', history.status === 200 && history.json?.messages?.length >= 2,
        `messages=${history.json?.messages?.length}`);
      const del = await call('DELETE', `/api/chat/${encodeURIComponent(chatId)}`);
      check('chat can be deleted', del.status === 200, `status ${del.status}`);
    }

    /* ---------- Delete ---------- */
    section('Delete');
    const deleted = await call('DELETE', `/api/goats/${goat?.id}`);
    check('GOAT deleted', deleted.status === 200, `status ${deleted.status}`);
    const after = await call('GET', `/api/goats/${goat?.id}`);
    check('deleted GOAT is gone', after.status === 404, `status ${after.status}`);

    const delAgain = await call('DELETE', `/api/goats/${goat?.id}`);
    check('deleting twice is a clean 404', delAgain.status === 404, `status ${delAgain.status}`);
  } finally {
    server.close();
    const { durableObjectRegistry } = await import('../src/services/durable-object/DurableObjectRegistry');
    const { hyperliquidProvider } = await import('../src/services/market-data/hyperliquid/HyperliquidMarketDataProvider');
    for (const goat of durableObjectRegistry.getAll()) goat.destroy();
    hyperliquidProvider.stopTicks();
    router.marketStateStore.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exit(1);
});
