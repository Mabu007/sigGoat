# FundAGoat — deployment, migration and verification status

**Date of last verification: 2026-10-10**

This document records what is implemented, what was tested against live
services, and what remains blocked on external factors. It is deliberately
explicit about the third category: nothing here should be read as a claim of
production readiness where production readiness has not been established.

---

## 1. Architecture preserved

| Component | Status | Notes |
|---|---|---|
| Cloudflare Worker (`worker/market-data-worker.ts`) | **preserved** | Same routes, same auth, same `scheduled()` cron. Only the outbound provider changed. |
| `MarketDataDO` | **preserved** | Same class name, same SQLite schema, same partition routing, same alarms. No migration required. |
| `GoatSchedulerDO` | **preserved** | Untouched. Same storage key, same alarm logic, same retry policy. |
| Wrangler bindings | **preserved** | `NAMESPACE` → `GoatSchedulerDO`, `MARKET_DATA` → `MarketDataDO`. Both SQLite-backed via existing migrations. |
| Vercel function build | **preserved** | `api/index.js` → `src/server/entry.ts` → `createApp()`. |
| Express dev server | **preserved** | `server.ts` unchanged apart from the provider import. |

**No Durable Object storage was destroyed, renamed or re-migrated.** The
Worker has not been deployed on this Cloudflare account (every namespace
lookup returned 404 at the time of writing), so there is no production state
to preserve.

---

## 2. What replaced BiQuote

### Removed
- `src/services/market-data/BiQuoteMarketDataProvider.ts` — deleted.
- `tests/biquote.test.ts` — deleted (tested only the removed class).
- The Worker's BiQuote client, `NATIVE_ALIASES` table and `nativeSymbol()`
  translator — deleted from `worker/market-data-worker.ts`.

### Added
- `src/services/market-data/hyperliquid/MarketCatalog.ts` — instrument
  normalisation, categorisation, search, default universe.
- `src/services/market-data/hyperliquid/HyperliquidClient.ts` — the `/info`
  client, rate-limit accounting, response parsing.
- `src/services/market-data/hyperliquid/HyperliquidMarketDataProvider.ts` —
  implements the existing `MarketDataProvider` interface unchanged.
- `worker/hyperliquid-provider.ts` — the Durable Object's outbound client.

### Symbol mapping is gone, deliberately

The previous build translated `EUR/USD → EURUSD` for BiQuote. That
translation is removed. **A market's symbol is now the provider's own coin
name, verbatim** — `BTC`, `xyz:GOLD`, `xyz:EUR`, `@107`. One identifier, one
meaning.

This is a breaking change for any stored GOAT that referenced `EUR/USD`,
`BTC/USD`, `US500` and similar. Those markets no longer resolve; the UI shows a
clear "not a market Hyperliquid lists" error rather than silently returning
nothing.

---

## 3. Market coverage — verified live, not assumed

Queried `POST https://api.hyperliquid.xyz/info` on 2026-10-10.

```
Default perp dex ("")      234 instruments  (56 delisted) — all crypto
HIP-3 perp dex ("xyz")     133 instruments  — FX, commodities, indices, equities
Discovery total            367 instruments
  crypto        350
  commodities    10
  currencies      3
  indices         4
```

**All four required categories are genuinely available**, but three of them are
served by a HIP-3 deployer market, not the default perp dex:

| Category | Provider | Instruments |
|---|---|---|
| Crypto | default perp dex | 350 |
| Currencies | `xyz` | `xyz:EUR`, `xyz:GBP`, `xyz:JPY` |
| Commodities | `xyz` | `xyz:GOLD`, `xyz:SILVER`, `xyz:CL`, `xyz:BRENTOIL`, `xyz:NATGAS`, `xyz:COPPER`, `xyz:CORN`, `xyz:PLATINUM`, `xyz:PALLADIUM`, `xyz:ALUMINIUM` |
| Indices | `xyz` | `xyz:JP225`, `xyz:KR200` (+ `xyz:NIFTY`, `xyz:DXY`, currently delisted) |

### What is NOT fabricated

There is **no `EURUSD`, `XAUUSD`, `SPX`, `US500`, `WTI` or `GER40`** anywhere in
the codebase. Conventional forex pairs do not exist on this venue: `xyz:EUR` is
a USD-quoted perpetual, and the app reports it under the provider's own name
rather than inventing a conventional label that would not resolve elsewhere.

`tests/hyperliquid.test.ts` asserts this explicitly.

### Two defaults were corrected because the venue delisted them

The first draft tracked `xyz:NIFTY` and `xyz:DXY`. A live metadata check
returned `isDelisted: true` for both. They were replaced with `xyz:JP225` and
`xyz:KR200`. The Durable Object now also reconciles its tracked universe against
live metadata hourly and drops anything the venue stops listing, so a future
delisting degrades to "fewer tracked markets" rather than "one market silently
returns no candles forever".

---

## 4. Rate-limit budget

Documented Hyperliquid limit: **1200 weight/min per IP**.

| Request | Weight | This app's use |
|---|---|---|
| `metaAndAssetCtxs` | 20 | once per dex, cached 10 minutes |
| `candleSnapshot` | 20 + 1 per 60 candles | 15 tracked markets × 1/min ≈ 15 × 28 = **420/min** |
| `allMids`, `l2Book` | 2 | not on the polling path |

The client enforces a 1100/min budget locally (below the documented 1200 so a
shared egress IP degrades on our side first, with backoff, instead of
returning 429 to users).

---

## 5. PropDAO — what is verified

Base URL `https://app.propdao.finance/api/v1`, auth `Authorization: Bearer pd_live_…`.

### Verified live (2026-10-10, unauthenticated endpoints)

```
GET /health     -> 200 {"status":"ok","services":{"db":"ok"}}
GET /markets    -> 200 {fees, marginMode:"isolated", data:[...]}
GET /challenges -> 200 {data:[...], total:16}
GET /me         -> 401 (no key held)
```

### Verified by documentation + SDK source, NOT by a live authenticated call

No PropDAO API key was available, so these are implemented from the official
docs but have not been exercised against a real account:
`/accounts`, `/accounts/:id`, `/accounts/:id/risk`, `/positions`, `/orders`,
`/trades`, `POST /orders`, `DELETE /orders/:orderId`,
`POST /positions/:pid/close`, `PATCH /positions/:pid`, `DELETE /twaps/:twapId`.

### Documented API limitations, encoded as capability flags

| Capability | Supported | Why |
|---|---|---|
| `modifyOrder` | **NO** | No `PATCH` on an order exists. Amending would be cancel-then-replace, which is not atomic. |
| `payout` | **NO** | "Payout is UI-only for now" — no endpoint. |
| `webhooks` | **NO** | No webhook endpoint documented. |

### Doc/API mismatches already observed

The published examples are stale. **Trust the live response, not the docs:**

| Field | Docs | Live |
|---|---|---|
| daily limit | `daily_loss` | `daily_drawdown` |
| markets total | 155 | 145 |
| equity leverage | 1.5× | 2× |

`parseChallengeRules` reads **both** field names for the daily limit. Reading
only the documented one would silently produce a null daily limit — and a null
daily limit is indistinguishable from "no daily limit", which is exactly the
gap a risk check must not have.

---

## 6. ⚠️ BLOCKER: commercial execution is not authorised

**Order placement is disabled, and cannot be enabled until PropDAO confirms in
writing that a third-party commercial integration is permitted.**

The evidence:

| Source | Says |
|---|---|
| Rules §4.2 / FAQ | "Automated trading is permitted" — for an **individual trader** automating their own account |
| **Terms §10** | Access licensed **"for personal, non-commercial use"** |
| **Terms §9** | Prohibits **"use automated systems without authorization"** |
| Terms §11 | Covers inbound third-party vendors only; says nothing about outbound builders |
| Terms (full text) | **No** clause on third-party API access, SaaS integration, reselling, or account sharing |
| propdao.finance/affiliates | **404** — no reseller program exists |
| Docs | **No** OAuth, no delegated access, no read-only key; "the key has the same power as your login" |

A paid third-party service holding customer keys and placing trades on their
behalf sits outside §10's grant on the face of the terms. The existence of a
public API does not establish permission to monetise it.

**Current behaviour** — `PROPDAO_EXECUTION_ENABLED=false` (default):

- Read-only features work fully: accounts, risk, positions, orders, trades,
  markets.
- Every write returns `EXECUTION_DISABLED` with a message explaining why.
- The UI states plainly that FundAGoat does not place orders.

**To enable** — all three variables must be set:

```
PROPDAO_EXECUTION_ENABLED=true
PROPDAO_EXECUTION_AUTHORISED=true
PROPDAO_EXECUTION_TERMS_REFERENCE="<date + reference of written approval>"
```

**To unblock:** written permission from PropDAO covering commercial
third-party API use and automated order placement.

---

## 7. Credential security

### Design

- **AES-256-GCM**, 256-bit key, fresh 96-bit nonce per operation, 128-bit tag
  verified on every decrypt.
- **Versioned envelope**: `v1.<keyId>.<nonce>.<ciphertext>.<tag>`, base64url.
- **Fails closed.** With no `CREDENTIAL_ENCRYPTION_KEY`, saving throws
  `ENCRYPTION_NOT_CONFIGURED` (HTTP 503). It never falls back to plaintext and
  never generates an ephemeral key.
- **Rotation supported.** `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` keeps old keys
  readable while records are rewritten; `needsRotation` reports what is left.
- **Four distinct failure codes** — `INVALID_CIPHERTEXT`, `DECRYPT_FAILED`,
  `KEY_NOT_AVAILABLE`, `ENCRYPTION_NOT_CONFIGURED` — because each needs a
  different operator response.
- **Storage is document-per-credential** (`credentials/{uid}_{provider}`), not
  fields on the user document, so Firestore rules can address them
  independently.

### Secret handling

- No route returns a decrypted secret. The only readers are server-side call
  sites that immediately make an outbound request.
- `redactSecrets` / `redactError` strip keys, JWTs, PEM blocks and sensitive
  headers by **name** before anything is logged.
- Bundle scan: no OpenRouter/PropDAO/Groq key, no PEM block, and the Firebase
  **admin** private key confirmed absent (checked plaintext *and* base64 — a
  plaintext grep cannot see a base64 leak).

### One architectural bug found and fixed during this work

The vault initially called `createPersistence()` for itself, producing a
**second** `FilePersistence` over the same `DATA_DIR`. Two objects, each with
its own in-memory copy of the whole state file, each rewriting it wholesale —
last writer wins. In production this is masked (Firestore is a shared
database); locally and in tests it destroys writes. Fixed by injecting the
application's persistence layer. Regression test:
`credentialsApi.test.ts › stores the secret ENCRYPTED, never as plaintext`.

### Legacy plaintext migration

`CredentialVault.migrateLegacyPlaintext` imports a plaintext key into the vault.
It is **not yet wired to a scheduled job**. Until it is:

- Legacy `keys.openRouter` / `keys.groq` values still exist in any deployment
  that has them.
- The vault does not read them, so a user must re-enter their key once.
- **This is a known limitation, not a completed migration.** Re-entering is
  safe; silently dropping a key is not.

---

## 8. Deployment steps

### 8.1 Required: the credential encryption key

```bash
openssl rand -base64 32     # exactly 32 bytes
```

Set on Vercel as a **server-side** environment variable:

```
CREDENTIAL_ENCRYPTION_KEY=<value>
CREDENTIAL_ENCRYPTION_KEY_ID=<label>
```

**Without this the app deploys and runs, but every credential save returns
503.** It does not fall back to plaintext.

**Never** set this as a `VITE_*` variable — those are compiled into the
browser bundle.

### 8.2 PropDAO (optional — read-only features only)

```
PROPDAO_API_BASE_URL=                       # leave blank for production
PROPDAO_EXECUTION_ENABLED=false
PROPDAO_EXECUTION_AUTHORISED=false
PROPDAO_EXECUTION_TERMS_REFERENCE=
```

Users supply their **own** key from Settings. There is deliberately no shared
server-side PropDAO key: one shared key would let any user's request act on
the account it belongs to.

### 8.3 Hyperliquid (optional)

```
HYPERLIQUID_INFO_URL=     # blank = https://api.hyperliquid.xyz/info
```

No API key required.

### 8.4 Worker

```bash
npx wrangler deploy
```

No config change is required. `wrangler.toml` is unchanged apart from comments:
same Worker name, same bindings, same migrations, same cron.

Secrets, if not already set:

```bash
npx wrangler secret put SCHEDULER_SECRET
npx wrangler secret put MARKET_DATA_SECRET   # optional, separate rotation
```

### 8.5 Deploy order

1. Set `CREDENTIAL_ENCRYPTION_KEY` on Vercel.
2. Deploy the Vercel app (`git push` — the README records that only a push
   reproduces build failures).
3. Deploy the Worker.
4. Deploy the updated Firestore rules (`credentials` collection is read-denied
   by default; the Admin SDK bypasses rules, so this is defence in depth).

### 8.6 Storage compatibility

Nothing to migrate. The Durable Object schema, storage keys and table names
are unchanged. Existing candle history under the old BiQuote symbols remains on
disk but is unreachable by the new provider; it will be pruned by the existing
retention job and is not worth a migration.

---

## 9. Verification results

| Check | Result |
|---|---|
| `bun test` | **773 pass, 0 fail** across 37 files |
| `npm run lint` (`tsc --noEmit`) | **clean** |
| `npm run build` | **succeeds** — web bundle + `.api-build/index.mjs` |
| Hyperliquid live discovery | **verified** — 367 instruments, 4 categories |
| Hyperliquid live candles | **verified** — 1m bars returned for all 15 defaults |
| Hyperliquid live quotes | **verified** — mid/bid/24h change from `metaAndAssetCtxs` |
| PropDAO unauthenticated endpoints | **verified live** — `/health`, `/markets`, `/challenges`; `/me` → 401 |
| PropDAO authenticated endpoints | **NOT verified** — no API key |
| PropDAO order placement | **NOT verified and BLOCKED** — see §6 |
| Bundle secret scan | **clean** |

Baseline before this work was 531 tests. The suite grew by 242 tests covering
Hyperliquid, PropDAO, the credential vault, redaction, API isolation and the
UI theme system.

---

## 10. Open items

1. **PropDAO commercial authorisation** — blocking for execution. §6.
2. **Live PropDAO authenticated testing** — needs a real API key from someone
   with a funded/challenge account.
3. **Legacy plaintext key migration is not automated** — see §7. Until it is,
   affected users must re-enter their OpenRouter/Groq key.
4. **`xyz:JP225` / `xyz:KR200` are thin markets.** They were chosen because
   `NIFTY` and `DXY` are delisted, but they may have gaps. The reconciliation
   and empty-candle handling are in place; expect "no candle history" on quiet
   intervals.
5. **Index coverage is genuinely narrow.** Two live indices exist on the HIP-3
   dex. The app shows two index markets, not the eight a conventional broker
   would. That is the venue's coverage, and it is presented as such.
6. **No rate-limit alerting.** The client enforces its budget and backs off,
   but there is no metric export when sustained usage approaches the limit.