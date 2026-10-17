# Merge notes — `feat/team-builder-skills-and-assets`

Branch has 3 commits. Merge order matters only in that `965d22f` is optional.

| Commit | What | Needed? |
| --- | --- | --- |
| `1b41492` | Teams become the only way to create trading agents | Yes |
| `b4684e0` | Skill picker, searchable assets, broker-free deployment | Yes |
| `965d22f` | Pre-existing dirty files (`bun.lock`, `auth.ts`) | Optional — drop if unwanted |

## Land in this order

`b4684e0` builds on `1b41492` (it revamps the member/deploy UI that commit
introduces). `965d22f` is independent — safe to drop.

## Things to know before merging

**Deploy no longer needs a broker. That is the intended behaviour, not a leak.**
cTrader's OpenAPI cannot be queried without a granted CTID, so cTrader now
falls back to a deterministic *simulated* feed when no account is connected.
`dataMode` stays `PAPER` and the UI labels it. Only `liveExecutionReadinessForUser`
requires a credential, and it guards order placement only. If you disagree with
that split, the chokepoint is `marketDataProviderForUser` in `src/server/apiRouter.ts`.

**`POST /api/goats` is gone (404), and with it `validateGoatInput`.** Any external
caller creating agents directly will break. This was requested. Skill template
routes are untouched.

**`src/data/systemGoats.ts` is now unused by `src/`** but still imported by
`tests/iam.test.ts`, so I left the file. Delete it only alongside that test.

**New files to review first:**
- `src/components/SearchablePicker.tsx` — the codebase had no combobox. ARIA
  wiring, outside-click dismissal and arrow-key roving focus are all new here.
- `src/services/market-data/ctrader/CTraderSymbolCatalog.ts` — a hand-curated
  cTrader asset list. It is a broker-independent *baseline only*; when a broker
  is connected the account-scoped list wins. Worth a domain-eye review, since a
  missing symbol here means a team cannot be configured for it without a broker.
- `PaperMarketDataProvider` gained an optional `symbols`/`basePrices` option.
  Default behaviour is identical; existing callers are unaffected.

**`tests/ui.test.ts` was already stale before this branch** (it asserts on
navigation labels and `grid-cols-5` that no longer exist). Tests were not run per
instruction. It will need a separate pass.

## Verify after merging

```bash
npx tsc --noEmit          # clean at time of commit
npx vite build            # clean at time of commit
npx tsx server.ts
```

With dev auth (`x-dev-user-id: any-user`), no broker connected:

```bash
# 1. cTrader assets are available with no broker
curl -s -H 'x-dev-user-id: u' 'localhost:3000/api/markets/assets?provider=ctrader'
#    expect dataMode PAPER, liveAvailable false, ~28 assets

# 2. deploying a cTrader team succeeds -> 201 DEPLOYED
curl -s -X POST -H 'x-dev-user-id: u' -H 'Content-Type: application/json' \
  localhost:3000/api/goat-teams -d '{"name":"T","memberGoatIds":[],"newMembers":[{"name":"A","jobTitle":"Risk","jobDescription":"Vetoes.","skillIds":["skill_liquidity_sweeps"]}],"deploy":true,"deployment":{"provider":"ctrader","asset":"XAUUSD","risk":{"maxPositionSizePercent":1},"liveTrading":false}}'

# 3. but live trading without a broker is refused -> 409
#    same body with "liveTrading":true

# 4. standalone creation is gone
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-dev-user-id: u' \
  -H 'Content-Type: application/json' localhost:3000/api/goats -d '{}'   # 404
```