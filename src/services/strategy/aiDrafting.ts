import {
  aiDraftSchema,
  buildAiDraftPrompt,
  buildFallbackDraft,
  draftGaps,
  parseAiDraft,
  type AiDraft,
  type DraftGap,
} from './aiDraft';

/**
 * THE DRAFTING SERVICE
 * ====================
 *
 * The whole stage A flow, in one testable place:
 *
 *   prompt  ->  model  ->  validated draft  ->  gaps the user must fill
 *
 * The service never throws for a bad answer and never invents trading
 * logic. A model that fails, times out or answers with something that is
 * not a draft produces a clearly labelled fallback, so the user still ends
 * up in the editor with their request in front of them.
 */

export type DraftOutcome =
  | {
    status: 'ok';
    draft: AiDraft;
    gaps: DraftGap[];
    warnings: string[];
    model: string;
    provider: string;
  }
  | { status: 'invalid_prompt'; message: string }
  | { status: 'provider_unavailable'; message: string; prompt: string }
  | { status: 'model_unavailable'; message: string; prompt: string };

export interface DraftServiceInput {
  /** The user's own words. */
  prompt: string;
  /** True when the user has a usable provider credential. */
  hasProvider: () => Promise<boolean>;
  /** The model that will answer, or null when none is usable. */
  pickModel: () => Promise<string | null>;
  /** The provider that will answer. */
  provider: () => Promise<string>;
  /** Asks the model. May throw, for example on a timeout. */
  askModel: (request: string, model: string) => Promise<string>;
  /** How long the model may take before the answer is given up on. */
  timeoutMs?: number;
}

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export async function draftStrategy(input: DraftServiceInput): Promise<DraftOutcome> {
  const prompt = input.prompt.trim();
  if (prompt.length < 10 || prompt.length > 4000) {
    return { status: 'invalid_prompt', message: 'Describe the strategy in 10-4000 characters.' };
  }
  if (!(await input.hasProvider())) {
    return {
      status: 'provider_unavailable',
      message: 'Connect an AI provider in Settings to draft a strategy. Your request is kept, and manual robot creation remains available.',
      prompt,
    };
  }
  const model = await input.pickModel();
  if (!model) {
    return { status: 'model_unavailable', message: 'No usable model is available for the configured provider.', prompt };
  }

  const request = buildAiDraftPrompt(prompt);
  const warnings: string[] = [];
  let draft: AiDraft | null = null;

  try {
    const answer = await withTimeout(input.askModel(request, model), input.timeoutMs ?? 120_000, 'The AI provider did not answer in time.');
    const parsed = parseAiDraft(answer, prompt);
    if (parsed.draft) draft = parsed.draft;
    else warnings.push(`${parsed.error ?? 'The AI answer could not be read.'} A minimal price-action draft was prepared from the wording of your request instead.`);
  } catch (error) {
    warnings.push(`The AI provider failed: ${error instanceof Error ? error.message : String(error)}. A minimal price-action draft was prepared from the wording of your request instead.`);
  }

  if (!draft) draft = buildFallbackDraft(prompt);

  return {
    status: 'ok',
    draft,
    gaps: draftGaps(draft),
    warnings,
    model,
    provider: await input.provider(),
  };
}

/** Parses a raw model answer into a draft, for callers that already have one. */
export function draftFromAnswer(answer: string, prompt = ''): { draft?: AiDraft; error?: string } {
  return parseAiDraft(answer, prompt);
}

/** The strict schema of a draft, exported so callers can validate one. */
export { aiDraftSchema };
