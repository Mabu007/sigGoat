import type { GoatTeam } from "./GoatTeamStore";

export interface TeamSignalLike {
  id?: string;
  direction?: string | null;
  confidence?: number | null;
  status?: string;
  createdAt?: string | null;
}

export interface TeamMarketVote {
  goatId: string;
  direction: string | null;
  signalId: string | null;
  confidence: number | null;
  status: string;
  createdAt: string | null;
}

export interface TeamMarketAssessment {
  market: string;
  outcome: string;
  votes: TeamMarketVote[];
}

/**
 * Deterministic, read-only coordination assessment. It only compares saved
 * member signals; it never authorizes or submits an order.
 */
export function assessGoatTeamMarket(
  team: Pick<GoatTeam, "coordinationMode" | "memberGoatIds" | "leadGoatId">,
  market: string,
  signalsByGoat: Map<string, TeamSignalLike | undefined>,
): TeamMarketAssessment {
  const votes: TeamMarketVote[] = team.memberGoatIds.map(goatId => {
    const signal = signalsByGoat.get(goatId);
    return {
      goatId,
      direction: signal?.direction ?? null,
      signalId: signal?.id ?? null,
      confidence: signal?.confidence ?? null,
      status: signal?.status ?? "NO_CURRENT_SIGNAL",
      createdAt: signal?.createdAt ?? null,
    };
  });
  const availableVotes = votes.filter(vote => vote.direction !== null);
  const directions = new Set(availableVotes.map(vote => vote.direction));
  let outcome: string;

  if (team.coordinationMode === "INDEPENDENT") {
    outcome = "INDEPENDENT_SIGNALS";
  } else if (team.coordinationMode === "CONSENSUS") {
    outcome = availableVotes.length !== team.memberGoatIds.length
      ? "WAITING_FOR_ALL_MEMBERS"
      : directions.size === 1 && availableVotes.every(vote => vote.direction === "LONG" || vote.direction === "SHORT")
        ? "CONSENSUS_READY"
        : "NO_CONSENSUS";
  } else {
    const lead = votes.find(vote => vote.goatId === team.leadGoatId);
    if (!lead || !lead.direction) outcome = "LEAD_SIGNAL_MISSING";
    else if (lead.direction !== "LONG" && lead.direction !== "SHORT") outcome = "LEAD_NO_TRADE";
    else if (votes.some(vote => vote.goatId !== team.leadGoatId && (vote.direction === "LONG" || vote.direction === "SHORT") && vote.direction !== lead.direction)) outcome = "REVIEW_CONFLICT";
    else outcome = "LEAD_REVIEW_REQUIRED";
  }

  return { market, outcome, votes };
}
