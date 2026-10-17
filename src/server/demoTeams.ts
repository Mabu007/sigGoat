/**
 * SIMULATED DEMO TEAMS
 * ====================
 * Two fully-formed, entirely invented trading teams, so the team experience can
 * be explored before any account, broker or AI key exists.
 *
 * NOTHING HERE IS REAL
 *   Every thesis, proposal, price level and timestamp below is fiction. No
 *   member here exists in persistence, none is scheduled, and nothing is sent
 *   to a model. The routes that serve this data are read-only, are labelled
 *   `isDemo`, and the room view refuses the accept/reject actions so a visitor
 *   cannot mistake a simulated proposal for a real decision record.
 *
 *   Prices are plausible-shaped but deliberately arbitrary. The point is to
 *   show layout, hierarchy and tone -- never to look like track record.
 *
 * TIMESTAMPS ARE RELATIVE
 *   Generated from `Date.now()` on each read so a demo room never looks stale,
 *   and so the two teams always have a plausible spread of activity.
 */

export interface DemoSignal {
  id: string;
  market: string;
  direction: string;
  status: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  thesis: string;
  rationale: string;
  createdAt: string;
  decision?: string;
}

export interface DemoMember {
  id: string;
  name: string;
  jobTitle: string;
  goal: string;
  skills: string[];
  markets: string[];
  status: string;
  provider: string;
  latestThesis: null | { market: string; bias: string; summary: string; updatedAt: string };
  signals: DemoSignal[];
}

export interface DemoTeam {
  id: string;
  slug: string;
  name: string;
  /** Why this team exists, shown on the room card. */
  tagline: string;
  instructions: string;
  asset: string;
  memberCount: number;
  coordinationMode: string;
  members: DemoMember[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Builds one demo team. Timestamps are offsets in the past, so ordering stays
 * fixed and the "most recent" item is always the same one.
 */
function buildTeam(spec: {
  slug: string;
  name: string;
  tagline: string;
  instructions: string;
  asset: string;
  coordinationMode: string;
  members: Array<Omit<DemoMember, 'id' | 'latestThesis' | 'signals'> & {
    thesis: { market: string; bias: string; summary: string };
    signals: Array<Omit<DemoSignal, 'id' | 'createdAt'> & { ago: number }>;
  }>;
}): DemoTeam {
  const now = Date.now();
  return {
    id: `demo_team_${spec.slug}`,
    slug: spec.slug,
    name: spec.name,
    tagline: spec.tagline,
    instructions: spec.instructions,
    asset: spec.asset,
    memberCount: spec.members.length,
    coordinationMode: spec.coordinationMode,
    members: spec.members.map((member, index) => ({
      id: `demo_member_${spec.slug}_${index + 1}`,
      name: member.name,
      jobTitle: member.jobTitle,
      goal: member.goal,
      skills: member.skills,
      markets: member.markets,
      status: member.status,
      provider: member.provider,
      latestThesis: {
        market: member.thesis.market,
        bias: member.thesis.bias,
        summary: member.thesis.summary,
        updatedAt: new Date(now - (index + 1) * 22 * MINUTE).toISOString(),
      },
      signals: member.signals.map((signal, signalIndex) => ({
        id: `demo_signal_${spec.slug}_${index + 1}_${signalIndex + 1}`,
        market: signal.market,
        direction: signal.direction,
        status: signal.status,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        thesis: signal.thesis,
        rationale: signal.rationale,
        createdAt: new Date(now - signal.ago).toISOString(),
        ...(signal.decision ? { decision: signal.decision } : {}),
      })),
    })),
  };
}

export const DEMO_TEAMS: DemoTeam[] = [
  buildTeam({
    slug: 'demo-london-breakout',
    name: 'London Breakout Desk',
    tagline: 'Three specialists trading the London open: one maps structure, one hunts liquidity sweeps, one holds the risk line.',
    instructions:
      'Only trade the 07:00-10:30 UTC window. Never carry a position overnight. Two members must agree before entry, and the Risk Manager can veto any setup without needing agreement.',
    asset: 'EURUSD',
    coordinationMode: 'LEAD_REVIEW',
    members: [
      {
        name: 'Mara',
        jobTitle: 'Structure Analyst',
        goal: 'Marks the higher-timeframe range and decides which way the session is allowed to break.',
        skills: ['Price Action', 'Multi-Timeframe Confirmation'],
        markets: ['EURUSD'],
        status: 'WATCHING',
        provider: 'cTrader',
        thesis: {
          market: 'EURUSD',
          bias: 'LONG',
          summary:
            'Asian range is 1.0841-1.0893. Price has compressed inside it for six hours with no displacement, so the range is still valid. Structure above 1.0893 is the only long trigger; a clean close back below 1.0841 invalidates the bullish case entirely.',
        },
        signals: [
          {
            market: 'EURUSD',
            direction: 'LONG',
            status: 'ACTIONABLE',
            entry: 1.08945,
            stopLoss: 1.0871,
            takeProfit: 1.0952,
            thesis: 'Buy the London expansion above the Asian range high.',
            rationale:
              'Range high at 1.0893 has been respected for three sessions. A 15m close above it with rising volume confirms the break rather than a liquidity grab, and the measured move targets the prior session high.',
            ago: 3 * HOUR + 12 * MINUTE,
          },
        ],
      },
      {
        name: 'Tobi',
        jobTitle: 'Liquidity Scout',
        goal: 'Finds stop runs and fakeouts before the real move, and reports whether a sweep already happened.',
        skills: ['Liquidity Sweep Analysis', 'Session Liquidity Awareness'],
        markets: ['EURUSD'],
        status: 'INVESTIGATING',
        provider: 'cTrader',
        thesis: {
          market: 'EURUSD',
          bias: 'NEUTRAL',
          summary:
            'Swept the Asian low at 1.0843 within two minutes of the London open and reclaimed it. That is a completed stop run rather than a fresh low, which argues the sell-side liquidity is already spent and the range low is less likely to be revisited.',
        },
        signals: [
          {
            market: 'EURUSD',
            direction: 'LONG',
            status: 'ACTIONABLE',
            entry: 1.0894,
            stopLoss: 1.0872,
            takeProfit: 1.0948,
            thesis: 'Enter long after the sweep-and-reclaim, not on the range break alone.',
            rationale:
              'Buying the raw range break gives away the stop run above it. Waiting for the reclaim keeps the stop under the swept low instead of paying for the sweep twice.',
            ago: 2 * HOUR + 40 * MINUTE,
          },
          {
            market: 'EURUSD',
            direction: 'SHORT',
            status: 'REJECTED',
            entry: 1.0841,
            stopLoss: 1.0864,
            takeProfit: 1.0798,
            thesis: 'Short the retest of the swept Asian low.',
            rationale: 'Retest never materialised; price held above the range floor for nine hours.',
            decision: 'REJECTED',
            ago: 26 * HOUR,
          },
        ],
      },
      {
        name: 'Ines',
        jobTitle: 'Risk Manager',
        goal: 'Caps position size, enforces the daily loss budget and can veto any setup.',
        skills: ['Risk-Aware Signal Validation', 'No-Trade Discipline'],
        markets: ['EURUSD'],
        status: 'WATCHING',
        provider: 'cTrader',
        thesis: {
          market: 'EURUSD',
          bias: 'NEUTRAL',
          summary:
            'Daily budget is 3% of equity with a 1% position cap. At the proposed 1.0894 entry the stop distance is 21 pips, which is inside acceptable slippage for a London open. No objection to the long, provided size is cut by half if the first fifteen minutes produce two consecutive lower lows.',
        },
        signals: [],
      },
    ],
  }),

  buildTeam({
    slug: 'demo-perp-macro',
    name: 'Perp Macro Desk',
    tagline: 'A single-member desk watching BTC perps, built to show the one-member case and an overnight hold.',
    instructions:
      'Hold overnight when the daily trend is intact. Reduce exposure ahead of any scheduled macro release. Risk one percent of equity per position and never stack two correlated positions.',
    asset: 'BTC',
    coordinationMode: 'INDEPENDENT',
    members: [
      {
        name: 'Sol',
        jobTitle: 'Macro Trader',
        goal: 'Watches the daily trend, takes macro-catalyst positions and manages the overnight carry.',
        skills: ['Trend Following & Pullbacks', 'Volatility Regime Monitoring'],
        markets: ['BTC'],
        status: 'WATCHING',
        provider: 'Hyperliquid',
        thesis: {
          market: 'BTC',
          bias: 'LONG',
          summary:
            'Daily structure has held higher lows for eleven sessions and the 4h is above its 50 EMA. Funding is mildly positive rather than crowded, so the trend is not yet the consensus trade it usually becomes at this stage. Holding the position through the US session is acceptable under the team instructions.',
        },
        signals: [
          {
            market: 'BTC',
            direction: 'LONG',
            status: 'ACTIONABLE',
            entry: 96420,
            stopLoss: 94850,
            takeProfit: 101200,
            thesis: 'Add on the pullback into the 4h 50 EMA rather than chasing the daily high.',
            rationale:
              'The prior three intraday highs failed to hold. Scaling in at the moving average gives a defined stop well below the last higher low, which a market entry at 96,900 would not.',
            ago: 55 * MINUTE,
          },
          {
            market: 'BTC',
            direction: 'LONG',
            status: 'ACCEPTED',
            entry: 94100,
            stopLoss: 92550,
            takeProfit: 98800,
            thesis: 'First entry on the 4h pullback.',
            rationale: 'Structure held and the reclaim of 94,000 confirmed the higher low.',
            decision: 'ACCEPTED',
            ago: 3 * 24 * HOUR,
          },
        ],
      },
    ],
  }),
];

export function findDemoTeam(slug: string): DemoTeam | null {
  return DEMO_TEAMS.find(team => team.slug === slug) ?? null;
}

/** Card payload for the public directory, matching `/api/goat-teams/public`. */
export function demoTeamCard(team: DemoTeam) {
  const theses = team.members
    .map(member => member.latestThesis)
    .filter((thesis): thesis is NonNullable<typeof thesis> => Boolean(thesis))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    description: `${team.memberCount} AI trader${team.memberCount === 1 ? '' : 's'} · ${team.coordinationMode.toLowerCase().replace('_', ' ')} coordination · ${team.asset}`,
    creatorName: 'Simulated demo',
    status: 'DEPLOYED',
    mode: 'TEAM' as const,
    memberCount: team.memberCount,
    markets: [team.asset],
    latestThesis: theses[0] ?? null,
    updatedAt: theses[0]?.updatedAt ?? new Date().toISOString(),
    isDemo: true as const,
  };
}