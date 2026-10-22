# AI trading robots

The Bots page now has two creation paths. **Create AI robot** creates one private GOAT team with one analyst member. The member runs the existing GOAT reasoning pipeline; it does not generate or execute Node.js strategy code. **Create strategy bot** remains available for the declarative candle-rule builder.

## Creation and runtime

The AI robot form collects a name, analysis instructions, OpenRouter model, provider, supported asset, analysis interval, preferred research sites, and an optional workspace cover. It creates a private workspace and deploys the member with live trading disabled. The cadence options are 5, 15, 30, and 60 minutes; 15 minutes is the default.

OpenRouter model discovery is server-side. The gateway resolves a user's encrypted key first and can fall back to the server-only `OPENROUTER_API_KEY`. The selected model must appear in the live catalogue and advertise structured output support. Secrets are not returned to the browser or included in the reasoning prompt.

GOAT runtime state, thesis, proposals, and evaluation history use the existing persistence and scheduler. In production, the configured durable scheduler controls recurring wakes; local development uses the existing in-process scheduler. The Cloudflare `RobotRunner` Durable Object in `worker/` currently schedules candle-strategy robots. It is not yet the scheduler for AI GOAT robots.

The AI receives the existing deterministic multi-timeframe candles, calculated indicators, market structure, saved thesis, and available research headlines. Numerical values stay sourced from market data and the indicator engine. User-authored analysis instructions cannot override the platform's reasoning contract or execution controls.

## Preferred research sites

Up to eight HTTPS publisher URLs can be saved with an AI robot. The server stores only normalized public hostnames. It uses them as `site:` filters in the existing cached Google News RSS search, alongside instrument-specific market terms. The service does not fetch those URLs directly, so configured domains cannot become arbitrary server-side request destinations. Each returned headline keeps its publisher, link, and publication time where the feed supplies them. Retrieved headline text remains untrusted input.

This is source-prioritized headline search, not unrestricted browsing or website scraping. No content is claimed when the feed is unavailable.

## Trading boundary

AI robots created through this flow start in paper research mode. Their model can produce proposals and `WAIT` decisions, but this flow does not submit real orders. Choosing cTrader uses the market data available through the current cTrader adapter; a BiQuote-to-cTrader market-data bridge is not part of this implementation. Hyperliquid asset selection uses the canonical instrument catalog. Live execution remains outside this AI robot flow until its separate account binding and order-validation path is explicitly implemented and verified.

The private workspace cover uses the existing room-cover upload and storage path. It is optional and can be added after the robot is created.
