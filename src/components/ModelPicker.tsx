/**
 * AI MODEL PICKER
 * ================
 * Loads the LIVE model catalogue for the signed-in user's own provider key and
 * lets them choose one.
 *
 * WHY THIS IS A COMPONENT AND NOT A HARDCODED LIST
 *
 * OpenRouter retires model slugs. This app shipped a hardcoded default of
 * `anthropic/claude-3.5-sonnet`, which the provider no longer serves at all —
 * every request answered "No endpoints found". A `<select>` over a literal
 * array would have shipped the same bug again the day the next model was
 * retired, so the only source of truth here is `GET /api/ai/models`, resolved
 * with the caller's own credential and cached server-side for a minute.
 *
 * FREE-FIRST ORDERING IS DELIBERATE
 *
 * A brand-new OpenRouter account has no credits, so only `:free` models
 * respond. Leading with paid models produces a GOAT that fails on every wake
 * with "Insufficient credits" and looks like a broken app rather than an
 * unfunded account. Free models are shown first and labelled; paid ones stay
 * selectable because an account with credits is a perfectly normal case.
 *
 * The component is intentionally dumb about persistence: it reports the
 * selection and the caller decides where it goes.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Search, Sparkles } from 'lucide-react';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  free: boolean;
  supportsStructuredOutputs: boolean;
}

/** How many models to show before the user has to search. */
const COLLAPSED_LIMIT = 40;

export interface ModelPickerProps {
  /** Resolves the caller's auth headers. */
  getApiAuthHeaders: () => Promise<Record<string, string>>;
  /** Currently saved model, or null when none is chosen. */
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Shown when no model is picked yet. */
  label?: string;
  error?: string | null;
  /**
   * Change this to force a reload — pass the provider's `keyConfigured` flag.
   *
   * The catalogue is fetched with the caller's own credential, so it can only
   * succeed AFTER a key is saved. Without this the picker would keep showing
   * "add your key first" until a full page reload, immediately after a
   * successful save, which reads as the save not having worked.
   */
  reloadKey?: boolean | string | null;
}

export function ModelPicker({
  getApiAuthHeaders,
  value,
  onChange,
  disabled = false,
  label = 'Reasoning model',
  error = null,
  reloadKey = null,
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const headers = await getApiAuthHeaders();
      const response = await fetch('/api/ai/models', { headers });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setLoadError(
          body?.error?.message ??
            'Could not load the model catalogue. Check your API key.',
        );
        setModels(null);
        return;
      }

      const list: ModelOption[] = Array.isArray(body?.models) ? body.models : [];
      setModels(list);
    } catch {
      setLoadError('Could not reach the server to load models.');
      setModels(null);
    } finally {
      setLoading(false);
    }
  }, [getApiAuthHeaders]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  /** Reload whenever the credential becomes available (or changes). */
  useEffect(() => {
    if (!reloadKey) return;
    void load();
    // Intentionally keyed on `reloadKey` alone: this is a "the world changed"
    // signal, not a value this component owns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /**
   * Order for display: the `:free` tier first, then other zero-priced models,
   * then the rest alphabetically.
   *
   * The `:free` suffix is OpenRouter's documented free tier and is the only
   * "free" signal that survives contact with the API — the catalogue lists
   * some models priced at zero that a zero-credit account still cannot call
   * (`402 Insufficient credits`, verified 2026-10-11). Showing those first is
   * how a new user ends up with a GOAT that fails every single wake.
   */
  const ordered = useMemo(() => {
    if (!models) return [];
    const rank = (m: ModelOption) => {
      if (m.id.endsWith(':free')) return 0;
      if (m.free) return 1;
      return 2;
    };
    return [...models].sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return a.name.localeCompare(b.name);
    });
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [ordered, search]);

  const visible = expanded || search.trim() ? filtered : filtered.slice(0, COLLAPSED_LIMIT);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-fg-muted">{label}</span>
        {loading && (
          <span className="flex items-center gap-1 text-[10px] text-fg-subtle">
            <Loader2 size={10} className="animate-spin" /> Loading
          </span>
        )}
        {!loading && models && (
          <button
            type="button"
            onClick={() => {
              loaded.current = false;
              void load();
            }}
            className="text-[10px] text-fg-subtle hover:text-fg underline underline-offset-2"
          >
            Refresh
          </button>
        )}
      </div>

      {loadError && (
        <div className="mb-2 rounded-lg border border-warning/40 bg-warning-soft p-2 text-[10px] leading-relaxed text-fg-muted">
          {loadError}
        </div>
      )}

      {models && models.length === 0 && (
        <div className="mb-2 rounded-lg border border-warning/40 bg-warning-soft p-2 text-[10px] text-fg-muted">
          OpenRouter returned an empty catalogue for this key.
        </div>
      )}

      {models && models.length > 0 && (
        <>
          <div className="relative mb-2">
            <Search
              size={12}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter models…"
              aria-label="Filter models"
              className="w-full !py-1.5 !pl-7 !text-[11px] bg-sunken border border-line rounded-lg text-fg placeholder-fg-subtle focus:outline-none focus:border-focus"
            />
          </div>

          <div
            className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line"
            role="radiogroup"
            aria-label={label}
          >
            {visible.map((model) => {
              const selected = value === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onChange(model.id)}
                  className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
                    selected ? 'bg-accent-soft' : 'hover:bg-raised'
                  }`}
                >
                  <span className="mt-0.5 w-3 shrink-0">
                    {selected && (
                      <CheckCircle size={12} className="text-accent-text" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-[11px] font-semibold ${selected ? 'text-accent-text' : 'text-fg'}`}>
                        {model.name}
                      </span>
                      {model.free && (
                        <span
                          className={`shrink-0 rounded px-1 text-[9px] font-bold ${
                            model.id.endsWith(':free')
                              ? 'bg-positive-soft text-positive'
                              : 'bg-sunken text-fg-subtle'
                          }`}
                        >
                          {model.id.endsWith(':free') ? 'FREE' : '$0'}
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-fg-subtle">
                      {model.id}
                    </span>
                  </span>
                </button>
              );
            })}

            {visible.length === 0 && (
              <p className="px-3 py-4 text-center text-[11px] text-fg-subtle">
                No model matches “{search}”.
              </p>
            )}
          </div>

          {!expanded && !search.trim() && filtered.length > COLLAPSED_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1.5 w-full rounded-lg border border-line py-1.5 text-[10px] font-semibold text-fg-muted hover:bg-raised"
            >
              Show all {filtered.length} models
            </button>
          )}

          {models.some((m) => m.free) && (
            <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-relaxed text-fg-muted">
              <Sparkles size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
              Free models are listed first because a new OpenRouter account has no
              credits — paid models will return “Insufficient credits” until you add
              some at openrouter.ai/settings/credits.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-negative">
          <AlertCircle size={11} aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}
