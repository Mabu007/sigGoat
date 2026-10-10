import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useGoat } from '../../context/GoatContext';
import { useAuth } from '../../context/AuthContext';
import { useMarket } from '../../context/MarketContext';
import { SkillParser } from '../../services/agent/SkillParser';
import {
  FundGoat,
  GoatSchedule,
  TrackerCondition,
  WakeEvent,
  TradeSignal,
  TradingSkill,
} from '../../types';
import { SCHEDULE_PRESETS } from '../../types';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Compass,
  Eye,
  Layers,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';

interface GoatsViewProps {
  isOpenCreateModal: boolean;
  onCloseCreateModal: () => void;
  onOpenCreateModal: () => void;
}

interface LiveModel {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  architecture?: {
    modality?: string;
    inputModalities?: string[];
    outputModalities?: string[];
  };
  supportedParameters?: string[];
  topProvider?: {
    contextLength?: number;
    maxCompletionTokens?: number;
  };
}

interface ModelCatalogueResponse {
  models: LiveModel[];
  fetchedAt?: number;
}

type ModelState = 'loading' | 'ready' | 'error';

const MODEL_CATALOGUE_ENDPOINT = '/api/ai/models';

/**
 * Create-form defaults.
 *
 * Venue symbols the provider actually lists, NOT conventional pairs from a
 * previous provider. `EUR/USD`, `US500` and similar no longer resolve;
 * selecting them would produce a GOAT that can never fetch data.
 */
const DEFAULT_MARKETS = ['BTC', 'ETH'];

/** Starter Markdown handed to the inline skill creator. */
const SKILL_STARTER_TEMPLATE = `---
name: My Trading Skill
timeframes: 15m, 1h
---

# My Trading Skill

Describe the methodology: what you look for, in what order, and why.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE

## Invalidation Rules
State precisely what would invalidate the thesis.
`;

const QUICK_PROMPTS = [
  'What are you watching right now?',
  'What is your current thesis?',
  'Why no signal yet?',
  'What would invalidate your thesis?',
];

const formatModelName = (model: LiveModel): string => {
  return model.name?.trim() || model.id;
};

const shortModelId = (id: string): string => {
  const parts = id.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : id;
};

const formatContext = (value?: number): string => {
  if (!value || !Number.isFinite(value)) return '—';

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  return String(value);
};

const formatPrice = (value?: number): string => {
  if (value === undefined || !Number.isFinite(value)) return '—';

  if (value === 0) return 'Free';

  if (value < 0.000001) return `$${value.toExponential(2)}`;

  if (value < 0.001) return `$${value.toFixed(6)}`;

  return `$${value.toFixed(4)}`;
};

const parsePricing = (
  model: LiveModel,
  type: 'input' | 'output'
): number | undefined => {
  const direct = type === 'input' ? model.inputPrice : model.outputPrice;

  if (typeof direct === 'number') {
    return direct;
  }

  const raw =
    type === 'input'
      ? model.pricing?.prompt
      : model.pricing?.completion;

  if (typeof raw === 'number') {
    return raw;
  }

  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const isTextReasoningModel = (model: LiveModel): boolean => {
  const outputModalities =
    model.architecture?.outputModalities?.map(v => v.toLowerCase()) || [];

  const modality = model.architecture?.modality?.toLowerCase() || '';

  if (
    outputModalities.length &&
    !outputModalities.some(
      value =>
        value.includes('text') ||
        value.includes('text->text')
    )
  ) {
    return false;
  }

  if (
    modality &&
    !modality.includes('text') &&
    !modality.includes('multimodal')
  ) {
    return false;
  }

  return true;
};

const normaliseCatalogue = (
  payload: ModelCatalogueResponse | LiveModel[] | unknown
): LiveModel[] => {
  const models = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as ModelCatalogueResponse).models)
      ? (payload as ModelCatalogueResponse).models
      : [];

  return models
    .filter(
      model =>
        model &&
        typeof model === 'object' &&
        typeof (model as LiveModel).id === 'string'
    )
    .filter(isTextReasoningModel)
    .map(model => {
      const typed = model as LiveModel;

      return {
        ...typed,
        name: formatModelName(typed),
      };
    })
    .sort((a, b) => {
      const aName = formatModelName(a).toLowerCase();
      const bName = formatModelName(b).toLowerCase();

      return aName.localeCompare(bName);
    });
};

export const GoatsView: React.FC<GoatsViewProps> = ({
  isOpenCreateModal,
  onCloseCreateModal,
  onOpenCreateModal,
}) => {
  const {
    goats,
    activeGoat,
    activeGoatState,
    setActiveGoatId,
    createGoat,
    setGoatStatus,
    deleteGoat,
    setGoatSchedule,
    busyGoatIds,
    wakeActiveGoat,
    askActiveGoat,
    isWaking,
    skills,
    createSkill,
    deleteSkill,
    refreshSkills,
    dataMode,
  } = useGoat();

  const { symbols } = useMarket();
  const { getApiAuthHeaders } = useAuth();

  /*
   * ------------------------------------------------------------------
   * LIVE OPENROUTER MODEL CATALOGUE
   * ------------------------------------------------------------------
   *
   * This view intentionally does not import a static model list.
   *
   * The backend owns credential resolution:
   *
   * Browser
   *   -> /api/ai/models   (authenticated with the caller's own credential)
   *   -> reasoning gateway (resolves the caller's key per uid)
   *   -> OpenRouter catalogue
   *
   * No API key is ever required (or read) in this component.
   */
  const [models, setModels] = useState<LiveModel[]>([]);
  const [modelState, setModelState] = useState<ModelState>('loading');
  const [modelError, setModelError] = useState('');
  const [modelsFetchedAt, setModelsFetchedAt] = useState<number | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [showModelDetails, setShowModelDetails] = useState(false);

  const loadModels = useCallback(async () => {
    setModelState('loading');
    setModelError('');

    try {
      const authHeaders = await getApiAuthHeaders();

      const response = await fetch(MODEL_CATALOGUE_ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;

        throw new Error(
          body?.error?.message ??
            `Model catalogue request failed (${response.status})`,
        );
      }

      const payload = (await response.json()) as ModelCatalogueResponse | LiveModel[];

      const nextModels = normaliseCatalogue(payload);

      if (!nextModels.length) {
        throw new Error('OpenRouter returned no text reasoning models.');
      }

      setModels(nextModels);
      setModelsFetchedAt(
        !Array.isArray(payload) && payload.fetchedAt
          ? payload.fetchedAt
          : Date.now()
      );
      setModelState('ready');
    } catch (error) {
      setModelState('error');
      setModelError(
        error instanceof Error
          ? error.message
          : 'Unable to load the live model catalogue.'
      );
    }
  }, [getApiAuthHeaders]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // Navigation
  const [detailGoatId, setDetailGoatId] = useState<string | null>(null);

  /*
   * ------------------------------------------------------------------
   * MY SKILLS + GOAT EXPLORER
   * ------------------------------------------------------------------
   *
   * Both reuse the EXISTING architecture: skills come from GoatContext (same
   * data the create/edit GOAT flow reads), and templates come from the
   * existing `/api/templates/*` catalogue endpoints (public, system-owned
   * records; copying is a POST that creates a NEW record owned by the
   * caller). No second skills system, no new persistence.
   */
  const [showSkillsSection, setShowSkillsSection] = useState(false);
  const [showExplorerSection, setShowExplorerSection] = useState(false);

  /** GOAT templates from /api/templates/goats. */
  interface GoatTemplate {
    id: string;
    name: string;
    goal: string;
    markets: string[];
    skillIds: string[];
    model: string;
    timeframe?: string;
    schedule?: GoatSchedule;
    isTemplate: boolean;
    performsTrades: boolean;
  }
  const [templates, setTemplates] = useState<GoatTemplate[]>([]);
  const [templatesState, setTemplatesState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [templatesError, setTemplatesError] = useState('');
  const [templateDetail, setTemplateDetail] = useState<GoatTemplate | null>(null);
  const [copyingTemplateId, setCopyingTemplateId] = useState<string | null>(null);
  const [copyTemplateError, setCopyTemplateError] = useState('');

  /** Skill templates from /api/templates/skills. */
  interface SkillTemplate {
    id: string;
    name: string;
    description: string;
    methodology: string;
    constraints: string;
    preferredTimeframes: string[];
    requiredEvidence: string;
    invalidationRules: string;
    isTemplate: boolean;
    executable: boolean;
  }
  const [skillTemplates, setSkillTemplates] = useState<SkillTemplate[]>([]);

  /** Inline skill creation (markdown, same builder the Skills view uses). */
  const [showSkillCreator, setShowSkillCreator] = useState(false);
  const [skillMarkdownInput, setSkillMarkdownInput] = useState('');
  const [isSavingSkill, setIsSavingSkill] = useState(false);
  const [skillCreateError, setSkillCreateError] = useState('');

  const loadTemplates = useCallback(async () => {
    setTemplatesState('loading');
    setTemplatesError('');

    try {
      const [goatRes, skillRes] = await Promise.all([
        fetch('/api/templates/goats', { headers: { Accept: 'application/json' } }),
        fetch('/api/templates/skills', { headers: { Accept: 'application/json' } }),
      ]);

      if (!goatRes.ok) throw new Error(`GOAT templates request failed (${goatRes.status})`);
      if (!skillRes.ok) throw new Error(`Skill templates request failed (${skillRes.status})`);

      const goatBody = await goatRes.json();
      const skillBody = await skillRes.json();

      setTemplates(
        Array.isArray(goatBody.templates)
          ? (goatBody.templates as GoatTemplate[])
          : [],
      );
      setSkillTemplates(
        Array.isArray(skillBody.templates)
          ? (skillBody.templates as SkillTemplate[])
          : [],
      );
      setTemplatesState('ready');
    } catch (err) {
      setTemplatesState('error');
      setTemplatesError(
        err instanceof Error ? err.message : 'Unable to load the template catalogue.',
      );
    }
  }, []);

  const handleCopyTemplate = async (template: GoatTemplate) => {
    setCopyTemplateError('');
    setCopyingTemplateId(template.id);

    try {
      const response = await fetch(`/api/templates/goats/${template.id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Copy failed (${response.status})`);
      }

      const body = await response.json();

      if (body?.goat?.id) {
        // Same path as creating a GOAT: refresh the runtime list and open it.
        handleOpenDetail(body.goat as FundGoat);
        setTemplateDetail(null);
      }
    } catch (err) {
      setCopyTemplateError(
        err instanceof Error ? err.message : 'Failed to create your own copy of this GOAT.',
      );
    } finally {
      setCopyingTemplateId(null);
    }
  };

  const handleCreateSkillFromBuilder = async () => {
    if (!skillMarkdownInput.trim()) {
      setSkillCreateError('Write the skill content before saving.');
      return;
    }

    setIsSavingSkill(true);
    setSkillCreateError('');

    try {
      // Parse is a pure function, so the constraints/timeframes are exactly
      // what the server will store — no divergence with the Skills view.
      const parsed = SkillParser.parse(skillMarkdownInput.trim());
      await createSkill({
        name: parsed.name,
        description: parsed.description,
        methodology: parsed.methodology,
        constraints: parsed.constraints,
        preferredTimeframes: parsed.preferredTimeframes,
        requiredEvidence: parsed.requiredEvidence,
        invalidationRules: parsed.invalidationRules,
        rawMarkdown: parsed.rawMarkdown,
      });
      setShowSkillCreator(false);
      setSkillMarkdownInput('');
    } catch (err) {
      setSkillCreateError(
        err instanceof Error ? err.message : 'Failed to save the skill.',
      );
    } finally {
      setIsSavingSkill(false);
    }
  };

  const handleDeleteSkill = async (id: string) => {
    // System-owned skills are refused by the server; the guard here avoids
    // the doomed round-trip and says why.
    const skill = skills.find((s) => s.id === id);
    if (skill?.isDefault) return;
    await deleteSkill(id);
  };

  const isTemplateSkill = (skillId: string): boolean =>
    skillTemplates.some((t) => t.id === skillId);

  const [copyingSkillId, setCopyingSkillId] = useState<string | null>(null);
  const [copySkillError, setCopySkillError] = useState('');

  /** Copies a built-in skill template into the caller's own library. */
  const handleCopySkillTemplate = async (templateId: string) => {
    setCopySkillError('');
    setCopyingSkillId(templateId);
    try {
      const res = await fetch(`/api/templates/skills/${templateId}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Copy failed (${res.status})`);
      }
      // The copy already persisted server-side; re-read the user's library so
      // it appears without a full page reload.
      await refreshSkills();
    } catch (err) {
      setCopySkillError(
        err instanceof Error ? err.message : 'Failed to copy the skill template.',
      );
    } finally {
      setCopyingSkillId(null);
    }
  };

  // Progressive disclosure
  const [showWakeEvents, setShowWakeEvents] = useState(false);
  const [showMarketReviews, setShowMarketReviews] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  // Inspectors
  const [selectedCondition, setSelectedCondition] =
    useState<TrackerCondition | null>(null);
  const [selectedWakeEvent, setSelectedWakeEvent] =
    useState<WakeEvent | null>(null);
  const [selectedReview, setSelectedReview] = useState<any | null>(null);

  // Chat
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatQuestion, setChatQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [chatMessages, setChatMessages] = useState<
    { sender: 'user' | 'goat'; text: string; time: string }[]
  >([
    {
      sender: 'goat',
      text:
        "🐐 I'm your FundAGoat.\n\n" +
        "Ask me what I'm watching, what my thesis is, " +
        'what conditions I need before acting, or what would invalidate the idea.',
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  ]);

  // Create GOAT
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [selectedMarkets, setSelectedMarkets] =
    useState<string[]>(DEFAULT_MARKETS);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([
    'skill_price_action',
    'skill_liquidity_sweeps',
  ]);
  const [selectedModel, setSelectedModel] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  /*
   * Reasoning interval, chosen at deploy time.
   *
   * 'PRESET' maps to SCHEDULE_PRESETS; 'TIMES' lets the user type exact
   * wall-clock times; 'TRACKERS' spends no AI tokens at all.
   */
  const [schedulePreset, setSchedulePreset] = useState<string>('60');
  const [customTimes, setCustomTimes] = useState<string[]>(['08:30']);

  // GOAT lifecycle actions
  const [pendingDelete, setPendingDelete] =
    useState<FundGoat | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [showScheduleEditor, setShowScheduleEditor] =
    useState(false);

  /**
   * Turns the interval form into the canonical schedule object.
   * Preset minutes of 0 = trackers only, -1 = manual only.
   */
  const buildSchedule = useCallback((): GoatSchedule => {
    const minutes = Number(schedulePreset);

    if (minutes === 0) {
      return { mode: 'TRACKERS' };
    }

    if (minutes === -1) {
      return { mode: 'MANUAL' };
    }

    if (schedulePreset === 'TIMES') {
      const times = customTimes
        .map(t => t.trim())
        .filter(t => /^\d{2}:\d{2}$/.test(t));

      return times.length > 0
        ? { mode: 'TIMES', times }
        : { mode: 'MANUAL' };
    }

    return {
      mode: 'INTERVAL',
      intervalMinutes: Number.isFinite(minutes)
        ? minutes
        : 60,
    };
  }, [schedulePreset, customTimes]);

  const describeScheduleLabel = useCallback(
    (schedule?: GoatSchedule): string => {
      if (!schedule) return 'Every hour';

      switch (schedule.mode) {
        case 'MANUAL':
          return 'Manual only';
        case 'TRACKERS':
          return 'Trackers only (no AI spend)';
        case 'TIMES':
          return `At ${(schedule.times ?? []).join(', ')}`;
        case 'INTERVAL':
        default: {
          const minutes = schedule.intervalMinutes ?? 60;
          if (minutes === 60) return 'Every hour';
          if (minutes === 240) return 'Every 4 hours';
          if (minutes >= 60 && minutes % 60 === 0) {
            return `Every ${minutes / 60} hours`;
          }
          return `Every ${minutes} minutes`;
        }
      }
    },
    []
  );

  const handleToggleStatus = async (goat: FundGoat) => {
    setActionError('');

    const pausing =
      goat.status !== 'PAUSED';

    try {
      await setGoatStatus(goat.id, pausing ? 'PAUSE' : 'PLAY');
    } catch (err: unknown) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Failed to change GOAT status.'
      );
    }
  };

  const handleRequestDelete = (goat: FundGoat) => {
    setActionError('');
    setPendingDelete(goat);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;

    setIsDeleting(true);
    setActionError('');

    try {
      await deleteGoat(pendingDelete.id);

      if (detailGoatId === pendingDelete.id) {
        setDetailGoatId(null);
      }

      setPendingDelete(null);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Failed to delete GOAT.'
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveSchedule = async (
    goatId: string,
    schedule: GoatSchedule
  ) => {
    setActionError('');

    try {
      await setGoatSchedule(goatId, schedule);
      setShowScheduleEditor(false);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Failed to update the schedule.'
      );
    }
  };

  /*
   * If an existing GOAT references a model which disappeared from
   * OpenRouter, retain that ID and explicitly surface it as unavailable.
   * Never silently replace it.
   */
  const selectedModelRecord = useMemo(
    () => models.find(model => model.id === selectedModel) ?? null,
    [models, selectedModel]
  );

  const selectedModelIsUnavailable =
    Boolean(selectedModel) &&
    modelState === 'ready' &&
    !selectedModelRecord;

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();

    if (!query) return models;

    return models.filter(model => {
      const haystack = [
        model.id,
        model.name,
        model.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [models, modelSearch]);

  /*
   * Select the first live model only when the user has not chosen one.
   * This is not substitution of a missing saved model: it only initializes
   * a brand-new creation form.
   */
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);

  const inspectedGoat = detailGoatId
    ? goats.find(g => g.id === detailGoatId) || activeGoat
    : activeGoat;

  const inspectedState =
    activeGoat?.id === inspectedGoat?.id ? activeGoatState : null;

  const handleOpenDetail = (goat: FundGoat) => {
    setActiveGoatId(goat.id);
    setDetailGoatId(goat.id);

    setShowWakeEvents(false);
    setShowMarketReviews(false);
    setShowEvidence(false);
  };

  const handleBackToList = () => {
    setDetailGoatId(null);
    setIsChatOpen(false);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !goal.trim() || !selectedMarkets.length) {
      setCreateError(
        'Please provide a name, objective goal, and select at least one market.'
      );
      return;
    }

    if (!selectedModel) {
      setCreateError(
        'Select a live reasoning model before deploying the GOAT.'
      );
      return;
    }

    if (selectedModelIsUnavailable) {
      setCreateError(
        'The selected model is no longer listed by OpenRouter. Choose a currently available model.'
      );
      return;
    }

    setCreateError('');
    setIsCreating(true);

    try {
      const created = await createGoat({
        name: name.trim(),
        goal: goal.trim(),
        markets: selectedMarkets,
        skillIds: selectedSkillIds,
        model: selectedModel,
        schedule: buildSchedule(),
      });

      onCloseCreateModal();

      setName('');
      setGoal('');
      setSelectedMarkets(DEFAULT_MARKETS);
      setSelectedSkillIds([
        'skill_price_action',
        'skill_liquidity_sweeps',
      ]);

      if (models.length > 0) {
        setSelectedModel(models[0].id);
      }

      if (created) {
        handleOpenDetail(created);
      }
    } catch (err: unknown) {
      setCreateError(
        err instanceof Error
          ? err.message
          : 'Failed to create GOAT.'
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!chatQuestion.trim() || isAsking) return;

    const userText = chatQuestion.trim();

    setChatMessages(prev => [
      ...prev,
      {
        sender: 'user',
        text: userText,
        time: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    ]);

    setChatQuestion('');
    setIsAsking(true);

    try {
      const answer = await askActiveGoat(userText);

      setChatMessages(prev => [
        ...prev,
        {
          sender: 'goat',
          text: answer,
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      ]);
    } catch (err: unknown) {
      setChatMessages(prev => [
        ...prev,
        {
          sender: 'goat',
          text:
            'I could not consult the live runtime state: ' +
            (err instanceof Error ? err.message : 'unknown error'),
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  const toggleMarket = (sym: string) => {
    setSelectedMarkets(prev =>
      prev.includes(sym)
        ? prev.length > 1
          ? prev.filter(s => s !== sym)
          : prev
        : [...prev, sym]
    );
  };

  const toggleSkill = (id: string) => {
    setSelectedSkillIds(prev =>
      prev.includes(id)
        ? prev.length > 1
          ? prev.filter(s => s !== id)
          : prev
        : [...prev, id]
    );
  };

  const formatEntryDisplay = (signal: TradeSignal): string => {
    if (signal.entryZone) {
      return `${signal.entryZone.low} – ${signal.entryZone.high}`;
    }

    if (signal.entry !== undefined) {
      return String(signal.entry);
    }

    return '—';
  };

  const dataSource =
    inspectedState?.dataSource ?? dataMode ?? 'PAPER';

  const reasoningMode =
    inspectedState?.reasoningMode ?? null;

  const getSemanticConditionText = (condition: TrackerCondition) => {
    switch (condition.type) {
      case 'PRICE_LEVEL':
        return `Price reaches ${
          condition.targetValue ?? 'tracked level'
        }`;

      case 'STRUCTURE':
        return 'Market structure confirms the required shift';

      case 'RSI_THRESHOLD':
        return `RSI moves ${
          condition.operator === 'GREATER_THAN' ? 'above' : 'below'
        } ${condition.targetValue || 50}`;

      case 'BREAKOUT':
        return 'Tracked breakout condition confirms';

      default:
        return `Market condition on ${condition.market}`;
    }
  };

  const signal = inspectedState?.latestSignal;

  const signalIsActionable =
    signal?.status === 'ACTIONABLE' &&
    signal.direction !== 'NO_TRADE';

  const signalIsNoTrade =
    signal?.direction === 'NO_TRADE' ||
    signal?.status === 'NO_TRADE';

  const liveModelCount = models.length;

  return (
    <div className="space-y-6 pb-20">
      {/* ============================================================= */}
      {/* LANDING                                                        */}
      {/* ============================================================= */}

      {!detailGoatId && (
        <div className="space-y-8">
          {/* Hero */}
          <div className="relative overflow-hidden rounded-3xl border border-line bg-raised p-5 sm:p-6">
            <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent-soft blur-3xl" />

            <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-accent/40 bg-accent-soft text-lg">
                    🐐
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="text-xl font-bold text-fg">
                        Your GOATs
                      </h1>

                      <span className="rounded-full border border-positive/40 bg-positive-soft px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-positive">
                        Live
                      </span>
                    </div>

                    <p className="mt-0.5 text-xs text-fg-muted">
                      Autonomous market reasoning, grounded in tracked
                      conditions.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-line bg-sunken px-2.5 py-1 text-[10px] font-mono text-fg-muted">
                    {goats.length} GOAT{goats.length === 1 ? '' : 's'}
                  </span>

                  <span className="rounded-full border border-line bg-sunken px-2.5 py-1 text-[10px] font-mono text-fg-muted">
                    {liveModelCount || '—'} live models
                  </span>

                  <span className="rounded-full border border-line bg-sunken px-2.5 py-1 text-[10px] font-mono text-fg-muted">
                    {dataMode || 'PAPER'} data
                  </span>
                </div>
              </div>

              <button
                onClick={onOpenCreateModal}
                className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-xs font-bold text-accent-fg shadow-lg shadow-accent/10 transition-colors hover:bg-accent-hover"
              >
                <Plus className="h-4 w-4" />
                Create GOAT
              </button>
            </div>
          </div>

          {/* GOAT GRID */}
          <section className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
                  My GOATs
                </div>
                <div className="mt-0.5 text-xs text-fg-subtle">
                  Open a GOAT to inspect its live reasoning state.
                </div>
              </div>

              {goats.length > 0 && (
                <span className="text-[10px] font-mono text-fg-subtle">
                  {goats.length} configured
                </span>
              )}
            </div>

            {goats.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-line bg-raised px-5 py-12 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent-soft text-2xl">
                  🐐
                </div>

                <h3 className="mt-4 text-sm font-bold text-fg">
                  Your first GOAT is waiting.
                </h3>

                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-fg-subtle">
                  Define an objective, assign markets and choose a live
                  reasoning model. The GOAT builds its own thesis and
                  tracked conditions after deployment.
                </p>

                <button
                  onClick={onOpenCreateModal}
                  className="mt-5 rounded-xl bg-accent px-4 py-2 text-xs font-bold text-accent-fg hover:bg-accent-hover"
                >
                  Create Your First GOAT
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {goats.map(goat => {
                  const isSelected = activeGoat?.id === goat.id;
                  const state = isSelected ? activeGoatState : null;

                  const latestSignal = state?.latestSignal;

                  const hasActionableSignal =
                    latestSignal?.status === 'ACTIONABLE' &&
                    latestSignal.direction !== 'NO_TRADE';

                  const trackerCount =
                    state?.trackers?.length ?? 0;

                  const goatIsPaused =
                    state?.status === 'PAUSED' ||
                    (state === null &&
                      goat.status === 'PAUSED');

                  const goatIsBusy =
                    busyGoatIds.includes(goat.id);

                  return (
                    <div
                      key={goat.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleOpenDetail(goat)}
                      onKeyDown={event => {
                        if (
                          event.key === 'Enter' ||
                          event.key === ' '
                        ) {
                          event.preventDefault();
                          handleOpenDetail(goat);
                        }
                      }}
                      className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:bg-raised cursor-pointer"
                    >
                      {hasActionableSignal && (
                        <div className="absolute inset-x-0 top-0 h-px bg-positive" />
                      )}

                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/40 bg-accent-soft">
                            🐐
                          </div>

                          <div className="min-w-0">
                            <h3 className="truncate text-sm font-bold text-fg group-hover:text-accent-text">
                              {goat.name}
                            </h3>

                            <p className="truncate text-[10px] font-mono text-fg-subtle">
                              {shortModelId(goat.model)}
                            </p>
                          </div>
                        </div>

                        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunken px-2 py-1 text-[9px] font-mono text-fg-muted">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              state?.status === 'ACTIVE' || state?.status === 'INVESTIGATING'
                                ? 'bg-positive'
                                : state?.status === 'WATCHING'
                                  ? 'bg-accent'
                                  : state?.status === 'DORMANT' || state?.status === 'PAUSED'
                                    ? 'bg-fg-subtle'
                                    : 'bg-fg-subtle'
                            }`}
                          />
                          {state?.status || goat.status}
                        </span>
                      </div>

                      {hasActionableSignal && (
                        <div className="mt-4 flex items-center gap-2 rounded-xl border border-positive/30 bg-positive-soft px-3 py-2">
                          <Zap className="h-3.5 w-3.5 text-positive" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-positive">
                            Actionable signal
                          </span>
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {goat.markets.slice(0, 4).map(market => (
                          <span
                            key={market}
                            className="rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] font-mono text-fg-muted"
                          >
                            {market}
                          </span>
                        ))}

                        {goat.markets.length > 4 && (
                          <span className="rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] font-mono text-fg-subtle">
                            +{goat.markets.length - 4}
                          </span>
                        )}
                      </div>

                      <p className="mt-4 line-clamp-2 text-xs leading-relaxed text-fg-muted">
                        {goat.goal}
                      </p>

                      <div className="mt-5 flex items-center justify-between gap-2 border-t border-line pt-3">
                        <div className="flex items-center gap-3 text-[10px] font-mono text-fg-subtle">
                          <span>
                            {trackerCount} condition
                            {trackerCount === 1 ? '' : 's'}
                          </span>

                          {latestSignal && (
                            <span
                              className={
                                signalIsNoTrade
                                  ? 'text-fg-subtle'
                                  : 'text-accent-text'
                              }
                            >
                              {latestSignal.direction}
                            </span>
                          )}
                        </div>

                        {/* Stop / Play / Delete */}
                        <div
                          className="flex shrink-0 items-center gap-1.5"
                          onClick={event =>
                            event.stopPropagation()
                          }
                          onKeyDown={event =>
                            event.stopPropagation()
                          }
                        >
                          <button
                            type="button"
                            title={
                              goatIsPaused
                                ? 'Resume this GOAT'
                                : 'Stop this GOAT (no analysis, no alerts)'
                            }
                            aria-label={
                              goatIsPaused
                                ? 'Play GOAT'
                                : 'Stop GOAT'
                            }
                            disabled={goatIsBusy}
                            onClick={event => {
                              event.stopPropagation();
                              void handleToggleStatus(goat);
                            }}
                            className="flex items-center gap-1 rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] font-bold text-fg-muted transition-colors hover:border-accent/40 hover:text-accent-text disabled:opacity-40 cursor-pointer"
                          >
                            {goatIsPaused ? (
                              <Play className="h-3 w-3" />
                            ) : (
                              <Pause className="h-3 w-3" />
                            )}
                            <span>
                              {goatIsPaused
                                ? 'Play'
                                : 'Stop'}
                            </span>
                          </button>

                          <button
                            type="button"
                            title="Delete this GOAT permanently"
                            aria-label="Delete GOAT"
                            disabled={goatIsBusy}
                            onClick={event => {
                              event.stopPropagation();
                              handleRequestDelete(goat);
                            }}
                            className="flex items-center gap-1 rounded-lg border border-negative/30 bg-negative-soft px-2 py-1 text-[10px] font-bold text-negative transition-colors hover:border-negative/50 hover:bg-negative-soft disabled:opacity-40 cursor-pointer"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Delete</span>
                          </button>

                          <span className="flex items-center gap-1 text-[11px] font-semibold text-accent-text">
                            Inspect
                            <ChevronRight className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* =========================================================== */}
          {/* MY SKILLS                                                    */}
          {/* =========================================================== */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <Layers className="h-4 w-4 text-accent-text" />
                <div>
                  <h3 className="text-xs font-bold text-fg">My Skills</h3>
                  <p className="text-[10px] text-fg-subtle">
                    Strategy constraints attached to your GOATs.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-fg-subtle">
                  {skills.length} skill{skills.length === 1 ? '' : 's'}
                </span>
                <button
                  onClick={() => {
                    setSkillMarkdownInput(SKILL_STARTER_TEMPLATE);
                    setSkillCreateError('');
                    setShowSkillCreator(true);
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[10px] font-bold text-accent-fg hover:bg-accent-hover"
                >
                  <Plus className="h-3 w-3" />
                  New skill
                </button>
                <button
                  onClick={() => setShowSkillsSection(prev => !prev)}
                  aria-expanded={showSkillsSection}
                  className="flex items-center gap-1 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[10px] font-semibold text-fg-muted hover:text-fg"
                >
                  {showSkillsSection ? 'Hide' : 'View all'}
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${showSkillsSection ? 'rotate-180' : ''}`}
                  />
                </button>
              </div>
            </div>

            {showSkillsSection && (
              <div className="mt-3 space-y-2">
                {skills.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line bg-raised px-3 py-4 text-center text-[11px] text-fg-subtle">
                    No skills yet. Create one, or copy a template from the built-in library below —
                    skills are attached to GOATs in the create/edit flow.
                  </p>
                ) : (
                  skills.map(skill => (
                    <div
                      key={skill.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-fg">{skill.name}</span>
                          {skill.isDefault ? (
                            <span className="rounded border border-line bg-sunken px-1.5 py-0.5 text-[9px] font-mono uppercase text-fg-muted">
                              Built-in
                            </span>
                          ) : (
                            <span className="rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[9px] font-mono uppercase text-accent-text">
                              Custom
                            </span>
                          )}
                        </div>
                        <p className="line-clamp-2 text-[11px] text-fg-muted">{skill.description}</p>
                      </div>

                      {!skill.isDefault && (
                        <button
                          type="button"
                          aria-label={`Delete skill ${skill.name}`}
                          onClick={() => void handleDeleteSkill(skill.id)}
                          className="shrink-0 rounded-lg border border-negative/30 bg-negative-soft px-2 py-1 text-[10px] font-bold text-negative hover:border-negative/50"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))
                )}

                {/* Built-in template library — copied via the existing POST endpoint. */}
                {skillTemplates.length > 0 && (
                  <div className="rounded-xl border border-line bg-sunken/60 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">
                      Built-in template library
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {skillTemplates.map(tpl => (
                        <button
                          key={tpl.id}
                          type="button"
                          disabled={copyingSkillId !== null}
                          title={`${tpl.description}\n\nCopying creates your own editable copy.`}
                          onClick={() => void handleCopySkillTemplate(tpl.id)}
                          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[10px] font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-accent-text disabled:opacity-50"
                        >
                          {copyingSkillId === tpl.id ? 'Copying…' : `+ ${tpl.name}`}
                        </button>
                      ))}
                    </div>

                    {copySkillError && (
                      <p className="mt-2 rounded-lg border border-negative/30 bg-negative-soft/50 px-2.5 py-1.5 text-[10px] text-negative">
                        {copySkillError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* =========================================================== */}
          {/* GOAT EXPLORER                                                */}
          {/* =========================================================== */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <Compass className="h-4 w-4 text-info" />
                <div>
                  <h3 className="text-xs font-bold text-fg">GOAT Explorer</h3>
                  <p className="text-[10px] text-fg-subtle">
                    System-created GOAT templates you can inspect and copy into your workspace.
                  </p>
                </div>
              </div>

              <button
                onClick={() => {
                  setShowExplorerSection(prev => !prev);
                  if (!templates.length && templatesState !== 'loading') void loadTemplates();
                }}
                aria-expanded={showExplorerSection}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[10px] font-semibold text-fg-muted hover:text-fg"
              >
                {showExplorerSection ? 'Hide' : 'Explore'}
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${showExplorerSection ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            {showExplorerSection && (
              <div className="mt-3 space-y-2">
                {templatesState === 'loading' && (
                  <p className="flex items-center gap-2 px-1 py-3 text-[11px] text-fg-muted">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Loading system GOATs…
                  </p>
                )}

                {templatesState === 'error' && (
                  <div className="flex items-start gap-2 rounded-xl border border-negative/30 bg-negative-soft/40 p-3">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-negative" />
                    <p className="text-[10px] text-negative">{templatesError}</p>
                  </div>
                )}

                {templatesState === 'ready' && templates.length === 0 && (
                  <p className="rounded-xl border border-dashed border-line bg-raised px-3 py-4 text-center text-[11px] text-fg-subtle">
                    No system GOATs are published yet.
                  </p>
                )}

                {templates.map(tpl => {
                  const detailed = templateDetail?.id === tpl.id;
                  return (
                    <div
                      key={tpl.id}
                      className="rounded-xl border border-line bg-raised px-3 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => setTemplateDetail(detailed ? null : tpl)}
                        aria-expanded={detailed}
                        className="w-full text-left"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-semibold text-fg">{tpl.name}</span>
                              <span className="rounded border border-info/40 bg-info-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-info">
                                System
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-fg-muted">{tpl.goal}</p>
                          </div>
                          <ChevronRight
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform ${detailed ? 'rotate-90' : ''}`}
                          />
                        </div>
                      </button>

                      {detailed && (
                        <div className="mt-3 space-y-2 border-t border-line pt-3">
                          <p className="text-[11px] leading-relaxed text-fg-muted">{tpl.goal}</p>

                          <div className="flex flex-wrap gap-1.5">
                            {tpl.markets.map(market => (
                              <span
                                key={market}
                                className="rounded-lg border border-line bg-sunken px-2 py-1 text-[10px] font-mono text-fg-muted"
                              >
                                {market}
                              </span>
                            ))}
                          </div>

                          {tpl.skillIds.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                                Skills:
                              </span>
                              {tpl.skillIds.map(id => (
                                <span
                                  key={id}
                                  className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[9px] text-fg-muted"
                                >
                                  {isTemplateSkill(id) ? `${id} (built-in)` : id}
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="flex items-center gap-2 text-[10px] font-mono text-fg-subtle">
                            <span>{shortModelId(tpl.model)}</span>
                            {tpl.timeframe && <span>· {tpl.timeframe}</span>}
                          </div>

                          <p className="text-[10px] leading-relaxed text-fg-subtle">
                            These are unverified starting points, not performance claims. Copying
                            creates a NEW GOAT owned by you; the template itself is never modified.
                          </p>

                          {copyTemplateError && (
                            <p className="rounded-lg border border-negative/30 bg-negative-soft/50 px-2.5 py-1.5 text-[10px] text-negative">
                              {copyTemplateError}
                            </p>
                          )}

                          <button
                            type="button"
                            onClick={() => void handleCopyTemplate(tpl)}
                            disabled={copyingTemplateId !== null}
                            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[10px] font-bold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                          >
                            {copyingTemplateId === tpl.id ? (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            {copyingTemplateId === tpl.id ? 'Copying…' : 'Create my own copy'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* LIVE MODEL STATUS */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <Sparkles className="h-4 w-4 text-accent-text" />

                <div>
                  <h3 className="text-xs font-bold text-fg">
                    Reasoning Model Catalogue
                  </h3>

                  <p className="text-[10px] text-fg-subtle">
                    Live availability from the reasoning provider.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {modelState === 'ready' && (
                  <span className="text-[10px] font-mono text-positive">
                    {liveModelCount} available
                  </span>
                )}

                <button
                  onClick={() => void loadModels()}
                  disabled={modelState === 'loading'}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[10px] font-semibold text-fg-muted hover:text-fg disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${
                      modelState === 'loading'
                        ? 'animate-spin'
                        : ''
                    }`}
                  />
                  Refresh
                </button>
              </div>
            </div>

            {modelState === 'error' && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-negative/30 bg-negative-soft/40 p-3">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-negative" />
                <div className="text-[10px] leading-relaxed text-negative">
                  {modelError}
                </div>
              </div>
            )}

            {modelsFetchedAt && modelState === 'ready' && (
              <div className="mt-3 text-[9px] font-mono text-fg-subtle">
                Catalogue refreshed{' '}
                {new Date(modelsFetchedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ============================================================= */}
      {/* SKILL CREATOR (same Markdown builder the Skills view uses)      */}
      {/* ============================================================= */}
      {showSkillCreator && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold text-fg">
                  <Sparkles className="h-4 w-4 text-accent-text" />
                  New skill (Markdown)
                </h3>
                <p className="mt-0.5 text-[11px] text-fg-subtle">
                  Frontmatter + headings. The parser extracts constraints, timeframes and evidence rules.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSkillCreator(false)}
                className="rounded-lg p-1.5 text-fg-subtle hover:bg-raised hover:text-fg"
                aria-label="Close skill creator"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {skillCreateError && (
                <div className="mb-3 rounded-xl border border-negative/40 bg-negative-soft/50 p-2.5 text-[11px] leading-relaxed text-negative">
                  {skillCreateError}
                </div>
              )}

              <textarea
                value={skillMarkdownInput}
                onChange={e => setSkillMarkdownInput(e.target.value)}
                rows={14}
                placeholder={
                  '---\nname: My Strategy\ntimeframes: 15m, 1h\n---\n\n# My Strategy\n\nMethodology…\n\n## Constraints\nREQUIRE_INVALIDATION_BEFORE_TRADE\n'
                }
                className="w-full resize-none rounded-xl border border-line bg-sunken p-3.5 font-mono text-xs leading-relaxed text-fg placeholder-fg-subtle focus:border-focus focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
              <button
                type="button"
                onClick={() => setShowSkillCreator(false)}
                className="btn btn-ghost"
                disabled={isSavingSkill}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateSkillFromBuilder()}
                disabled={isSavingSkill || !skillMarkdownInput.trim()}
                className="btn btn-primary"
              >
                {isSavingSkill ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {isSavingSkill ? 'Saving…' : 'Save skill'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-negative/40 bg-surface shadow-2xl">
            <div className="flex items-center gap-2 border-b border-line p-4">
              <ShieldAlert className="h-4 w-4 text-negative" />
              <h3 className="text-sm font-bold text-fg">
                Delete “{pendingDelete.name}”?
              </h3>
            </div>

            <div className="space-y-3 p-5 text-xs text-fg-muted">
              <p>
                This permanently removes the GOAT, its thesis, its tracked
                conditions and its signals.
              </p>

              <p className="text-[11px] text-fg-subtle">
                This cannot be undone. If you only want it to stop
                analysing, use <strong>Stop</strong> instead — the GOAT
                keeps its thesis and conditions and can be resumed.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-line p-4">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={isDeleting}
                className="rounded-xl px-4 py-2 text-xs font-semibold text-fg-muted hover:text-fg disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={isDeleting}
                className="flex items-center gap-2 rounded-xl bg-negative px-4 py-2 text-xs font-bold text-accent-fg hover:bg-negative disabled:opacity-50 cursor-pointer"
              >
                {isDeleting ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {isDeleting
                  ? 'Deleting...'
                  : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* GOAT DETAIL                                                     */}
      {/* ============================================================= */}

      {detailGoatId && inspectedGoat && (
        <div className="space-y-5">
          {/* Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <button
              onClick={handleBackToList}
              className="flex items-center gap-1.5 py-1 text-xs text-fg-muted hover:text-fg"
            >
              <ArrowLeft className="h-4 w-4" />
              All GOATs
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() =>
                  setShowScheduleEditor(
                    prev => !prev
                  )
                }
                title="Change how often this GOAT analyses the market"
                className="flex items-center gap-1.5 rounded-xl border border-line bg-sunken px-3 py-1.5 text-xs font-semibold text-fg-muted hover:bg-raised"
              >
                <Clock className="h-3.5 w-3.5 text-accent-text" />
                {describeScheduleLabel(inspectedGoat.schedule)}
                <ChevronDown
                  className={`h-3 w-3 text-fg-subtle transition-transform ${
                    showScheduleEditor
                      ? 'rotate-180'
                      : ''
                  }`}
                />
              </button>

              <button
                onClick={() =>
                  wakeActiveGoat(
                    'Manual market reassessment requested'
                  )
                }
                disabled={isWaking}
                className="flex items-center gap-1.5 rounded-xl border border-line bg-sunken px-3 py-1.5 text-xs font-semibold text-fg hover:bg-raised disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-accent-text ${
                    isWaking ? 'animate-spin' : ''
                  }`}
                />
                {isWaking ? 'Reassessing...' : 'Wake & Re-evaluate'}
              </button>

              <button
                onClick={() =>
                  void handleToggleStatus(inspectedGoat)
                }
                disabled={busyGoatIds.includes(inspectedGoat.id)}
                className="flex items-center gap-1.5 rounded-xl border border-line bg-sunken px-3 py-1.5 text-xs font-semibold text-fg hover:bg-raised disabled:opacity-50"
              >
                {inspectedGoat.status === 'PAUSED' ? (
                  <Play className="h-3.5 w-3.5 text-positive" />
                ) : (
                  <Pause className="h-3.5 w-3.5 text-accent-text" />
                )}
                {inspectedGoat.status === 'PAUSED'
                  ? 'Play'
                  : 'Stop'}
              </button>

              <button
                onClick={() =>
                  handleRequestDelete(inspectedGoat)
                }
                disabled={busyGoatIds.includes(inspectedGoat.id)}
                title="Delete this GOAT permanently"
                className="flex items-center gap-1.5 rounded-xl border border-negative/30 bg-negative-soft px-3 py-1.5 text-xs font-semibold text-negative hover:bg-negative-soft disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>

              <button
                onClick={() => setIsChatOpen(true)}
                className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-xs font-bold text-accent-fg hover:bg-accent-hover"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Chat
              </button>
            </div>
          </div>

          {actionError && (
            <div className="flex items-start gap-2 rounded-xl border border-negative/40 bg-negative-soft p-3 text-xs text-negative">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {showScheduleEditor && (
            <section className="rounded-2xl border border-accent/30 bg-surface p-4">
              <h3 className="flex items-center gap-2 text-xs font-bold text-fg">
                <Clock className="h-4 w-4 text-accent-text" />
                Analysis Interval
              </h3>

              <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
                Controls AI spend only. Trackers keep evaluating on every
                price tick regardless of this setting.
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {SCHEDULE_PRESETS.map(preset => {
                  const schedule = inspectedGoat.schedule;

                  const isActive =
                    preset.minutes === 0
                      ? schedule?.mode === 'TRACKERS'
                      : preset.minutes === -1
                        ? schedule?.mode === 'MANUAL'
                        : schedule?.mode === 'INTERVAL' &&
                          schedule.intervalMinutes ===
                            preset.minutes;

                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        void handleSaveSchedule(
                          inspectedGoat.id,
                          preset.minutes === 0
                            ? { mode: 'TRACKERS' }
                            : preset.minutes === -1
                              ? { mode: 'MANUAL' }
                              : {
                                  mode: 'INTERVAL',
                                  intervalMinutes:
                                    preset.minutes,
                                },
                        )
                      }
                      disabled={busyGoatIds.includes(
                        inspectedGoat.id
                      )}
                      className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors disabled:opacity-40 cursor-pointer ${
                        isActive
                          ? 'border-accent/50 bg-accent-soft text-accent-text'
                          : 'border-line bg-sunken text-fg-muted hover:border-line-strong'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Identity */}
          <section className="relative overflow-hidden rounded-3xl border border-line bg-surface p-4 sm:p-5">
            <div className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-accent-soft blur-3xl" />

            <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/40 bg-accent-soft text-xl">
                    🐐
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-base font-bold text-fg sm:text-lg">
                        {inspectedGoat.name}
                      </h1>

                      <span className="rounded-full border border-positive/40 bg-positive-soft px-2 py-0.5 text-[9px] font-mono font-bold uppercase text-positive">
                        {inspectedState?.status || inspectedGoat.status}
                      </span>

                      {signalIsActionable && (
                        <span className="flex items-center gap-1 rounded-full border border-positive/40 bg-positive-soft px-2 py-0.5 text-[9px] font-bold uppercase text-positive">
                          <Zap className="h-2.5 w-2.5" />
                          Signal Active
                        </span>
                      )}

                      {dataSource === 'PAPER' && (
                        <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[9px] font-mono text-accent-text">
                          PAPER DATA
                        </span>
                      )}

                      {reasoningMode === 'DEMO' && (
                        <span className="rounded-full border border-negative/40 bg-negative-soft px-2 py-0.5 text-[9px] font-mono text-negative">
                          DEMO MODE
                        </span>
                      )}
                    </div>

                    <p className="mt-1 max-w-3xl text-xs leading-relaxed text-fg-muted">
                      {inspectedGoat.goal}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 lg:max-w-md lg:justify-end">
                {inspectedGoat.markets.map(market => (
                  <span
                    key={market}
                    className="rounded-lg border border-line bg-sunken px-2.5 py-1 text-xs font-mono text-fg-muted"
                  >
                    {market}
                  </span>
                ))}

                <span className="max-w-full truncate rounded-lg border border-line bg-sunken/60 px-2 py-1 text-[10px] font-mono text-fg-muted">
                  {shortModelId(inspectedGoat.model)}
                </span>
              </div>
            </div>
          </section>

          {/* ========================================================= */}
          {/* SIGNAL — THE PRIMARY ARTIFACT                              */}
          {/* ========================================================= */}

          <section
            className={`overflow-hidden rounded-3xl border ${
              signalIsActionable
                ? 'border-positive/40'
                : 'border-line'
            } bg-surface`}
          >
            <div className="border-b border-line p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <Target
                    className={`h-4 w-4 ${
                      signalIsActionable
                        ? 'text-positive'
                        : 'text-info'
                    }`}
                  />

                  <div>
                    <h3 className="text-sm font-bold text-fg">
                      Trade Idea
                    </h3>

                    <p className="text-[10px] text-fg-subtle">
                      The current decision produced by the GOAT.
                    </p>
                  </div>
                </div>

                {signal ? (
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider ${
                      signalIsActionable
                        ? 'border-positive/40 bg-positive-soft text-positive'
                        : 'border-line bg-sunken text-fg-muted'
                    }`}
                  >
                    {signal.direction}
                  </span>
                ) : (
                  <span className="rounded-full border border-line bg-sunken px-2.5 py-1 text-[9px] font-mono text-fg-subtle">
                    NO SIGNAL
                  </span>
                )}
              </div>
            </div>

            {signal && signal.direction !== 'NO_TRADE' ? (
              <div className="space-y-4 p-4 sm:p-5">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-xl border border-line bg-sunken/60 p-3">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                      Order
                    </span>
                    <span className="mt-1 block text-xs font-bold font-mono text-accent-text">
                      {signal.orderType || '—'}
                    </span>
                  </div>

                  <div className="rounded-xl border border-line bg-sunken/60 p-3">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                      Entry
                    </span>
                    <span className="mt-1 block text-xs font-bold font-mono text-fg">
                      {formatEntryDisplay(signal)}
                    </span>
                  </div>

                  <div className="rounded-xl border border-line bg-sunken/60 p-3">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                      Invalidation
                    </span>
                    <span className="mt-1 block text-xs font-bold font-mono text-negative">
                      {signal.stopLoss ?? '—'}
                    </span>
                  </div>

                  <div className="rounded-xl border border-line bg-sunken/60 p-3">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                      Target
                    </span>
                    <span className="mt-1 block text-xs font-bold font-mono text-positive">
                      {signal.takeProfit ?? '—'}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-sunken/40 p-4">
                  <div className="space-y-3 text-xs leading-relaxed">
                    <div>
                      <span className="font-bold text-fg">
                        Rationale
                      </span>

                      <p className="mt-1 text-fg-muted">
                        {signal.rationale || 'No rationale recorded.'}
                      </p>
                    </div>

                    <div className="border-t border-line pt-3">
                      <span className="font-bold text-fg">
                        Confirmation required
                      </span>

                      <p className="mt-1 text-accent-text">
                        {signal.confirmationRequired || '—'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-5 sm:p-6">
                <div className="rounded-2xl border border-line bg-sunken/40 p-5">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-fg-subtle" />

                    <div>
                      <h4 className="text-xs font-bold text-fg">
                        No actionable signal
                      </h4>

                      <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
                        The GOAT can maintain a thesis without emitting a
                        trade signal. A signal only becomes actionable when
                        the required evidence and tracked conditions align.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ========================================================= */}
          {/* THESIS                                                       */}
          {/* ========================================================= */}

          <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex flex-col gap-3 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-accent-text" />

                <div>
                  <h3 className="text-sm font-bold text-fg">
                    Current Thesis
                  </h3>

                  <p className="text-[10px] text-fg-subtle">
                    What the GOAT currently believes and what it is
                    watching to prove or invalidate that belief.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="rounded-lg border border-accent/30 bg-accent-soft px-2 py-0.5 text-[9px] font-mono uppercase text-accent-text">
                  {inspectedState?.currentThesis
                    ?.directionalHypothesis || 'NEUTRAL'}
                </span>

                <span className="text-[10px] font-mono text-fg-subtle">
                  {inspectedState?.currentThesis
                    ? `${inspectedState.currentThesis.confidence}% confidence`
                    : 'No confidence recorded'}
                </span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {/* STEP 1 — the state of the asset(s) */}
              {inspectedState?.currentThesis?.assetState && (
                <div className="rounded-xl border border-line bg-sunken/50 p-3">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
                    Market State
                  </span>

                  <p className="mt-1 text-xs leading-relaxed text-fg">
                    {inspectedState.currentThesis.assetState}
                  </p>
                </div>
              )}

              {/* STEP 2 — the plan: ordered wait-for conditions */}
              {(inspectedState?.currentThesis?.tradePlan
                ?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-accent-text">
                    Plan · what we're waiting for
                  </span>

                  <ol className="mt-2 space-y-1.5">
                    {(
                      inspectedState?.currentThesis?.tradePlan ??
                      []
                    ).map((step, stepIndex) => (
                      <li
                        key={`${stepIndex}-${step.slice(0, 24)}`}
                        className="flex gap-2 text-xs leading-relaxed text-fg"
                      >
                        <span className="shrink-0 font-mono text-accent-text">
                          {stepIndex + 1}.
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <p className="text-xs leading-relaxed text-fg">
                {inspectedState?.currentThesis?.observationPlan ||
                  (inspectedState?.currentThesis
                    ? 'No observation plan recorded.'
                    : `No active thesis yet. Wake ${inspectedGoat.name} to run its first market review.`)}
              </p>

              <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line/70 pt-3 text-[10px] text-fg-subtle">
                <span>
                  Timeframe:{' '}
                  <strong className="font-mono text-fg-muted">
                    {inspectedState?.currentThesis
                      ?.relevantTimeframe || '—'}
                  </strong>
                </span>

                <span>
                  Status:{' '}
                  <strong className="font-mono text-positive">
                    {inspectedState?.currentThesis?.status || '—'}
                  </strong>
                </span>
              </div>
            </div>
          </section>

          {/* ========================================================= */}
          {/* TRACKERS                                                     */}
          {/* ========================================================= */}

          <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex flex-col gap-2 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-accent-text" />

                <div>
                  <h3 className="text-sm font-bold text-fg">
                    Tracked Conditions
                  </h3>

                  <p className="text-[10px] text-fg-subtle">
                    Deterministic events that can wake the GOAT.
                  </p>
                </div>
              </div>

              <span className="text-[10px] font-mono text-fg-subtle">
                {inspectedState?.trackers?.length ?? 0} active
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {(inspectedState?.trackers ?? []).map(condition => (
                <button
                  key={condition.id}
                  onClick={() => setSelectedCondition(condition)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-sunken/60 p-3 text-left hover:border-accent/40 hover:bg-sunken"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        condition.isTriggered
                          ? 'bg-positive'
                          : 'bg-accent'
                      }`}
                    />

                    <span className="truncate text-xs font-medium text-fg">
                      {getSemanticConditionText(condition)}
                    </span>

                    {condition.formulaDescription && (
                      <span className="shrink-0 rounded-md border border-line bg-sunken px-1.5 py-0.5 text-[9px] font-mono text-fg-muted">
                        {condition.formulaDescription}
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-[10px] font-mono text-fg-subtle sm:inline">
                      {condition.market}
                    </span>

                    {condition.currentCalculatedValue !==
                      undefined && (
                      <span className="hidden text-[10px] font-mono text-info sm:inline">
                        now{' '}
                        {
                          condition.currentCalculatedValue
                        }
                      </span>
                    )}

                    <span
                      className={`rounded-md px-2 py-0.5 text-[9px] font-mono ${
                        condition.isTriggered
                          ? 'bg-positive-soft text-positive'
                          : 'bg-raised text-fg-muted'
                      }`}
                    >
                      {condition.isTriggered
                        ? 'TRIGGERED'
                        : 'WAITING'}
                    </span>

                    <ChevronRight className="h-3.5 w-3.5 text-fg-subtle" />
                  </div>
                </button>
              ))}

              {!inspectedState?.trackers?.length && (
                <div className="rounded-xl border border-dashed border-line py-8 text-center text-xs text-fg-subtle">
                  No tracked conditions yet.
                  <br />
                  They are created by the GOAT after market reasoning.
                </div>
              )}
            </div>
          </section>

          {/* ========================================================= */}
          {/* DISCLOSURE                                                   */}
          {/* ========================================================= */}

          <div className="space-y-2.5">
            <Disclosure
              open={showWakeEvents}
              onToggle={() => setShowWakeEvents(v => !v)}
              title="Wake Events"
              subtitle={`${inspectedState?.recentWakeEvents?.length ?? 0} recorded`}
              icon={<Zap className="h-3.5 w-3.5" />}
            >
              {(inspectedState?.recentWakeEvents ?? []).map(event => (
                <button
                  key={event.id}
                  onClick={() => setSelectedWakeEvent(event)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-sunken/60 p-3 text-left hover:bg-sunken"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-mono text-accent-text">
                        {new Date(event.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>

                      <span className="text-xs font-semibold text-fg">
                        {event.reason}
                      </span>
                    </div>

                    <p className="mt-1 line-clamp-1 text-[10px] text-fg-subtle">
                      {event.details}
                    </p>
                  </div>

                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                </button>
              ))}

              {!inspectedState?.recentWakeEvents?.length && (
                <EmptyDisclosure text="No wake events recorded yet." />
              )}
            </Disclosure>

            <Disclosure
              open={showMarketReviews}
              onToggle={() => setShowMarketReviews(v => !v)}
              title="Market Review History"
              subtitle="Session-open reviews"
              icon={<Calendar className="h-3.5 w-3.5" />}
            >
              {(inspectedState?.recentWakeEvents ?? [])
                .filter(event => event.triggerType === 'SESSION_OPEN')
                .map(event => (
                  <button
                    key={event.id}
                    onClick={() => setSelectedWakeEvent(event)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-sunken/60 p-3 text-left hover:bg-sunken"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-fg">
                          Session Review
                        </span>

                        <span className="rounded-md bg-raised px-1.5 py-0.5 text-[9px] font-mono text-accent-text">
                          {new Date(
                            event.timestamp
                          ).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>

                      <p className="mt-1 line-clamp-1 text-[10px] text-fg-subtle">
                        {event.details}
                      </p>
                    </div>

                    <ChevronRight className="h-3.5 w-3.5 text-fg-subtle" />
                  </button>
                ))}

              {!(inspectedState?.recentWakeEvents ?? []).some(
                event => event.triggerType === 'SESSION_OPEN'
              ) && (
                <EmptyDisclosure text="No session-open reviews recorded." />
              )}
            </Disclosure>

            <Disclosure
              open={showEvidence}
              onToggle={() => setShowEvidence(v => !v)}
              title="Evidence & Reasoning"
              subtitle="Supporting and contradictory evidence"
              icon={<Layers className="h-3.5 w-3.5" />}
            >
              <div className="space-y-4">
                <EvidenceList
                  title="Supporting Evidence"
                  tone="positive"
                  items={
                    inspectedState?.currentThesis
                      ?.supportingEvidence ?? []
                  }
                />

                <EvidenceList
                  title="Contradictory Evidence"
                  tone="negative"
                  items={
                    inspectedState?.currentThesis
                      ?.contradictoryEvidence ?? []
                  }
                />

                <EvidenceList
                  title="Invalidation Conditions"
                  tone="negative"
                  items={
                    inspectedState?.currentThesis
                      ?.invalidationConditions ?? []
                  }
                />
              </div>
            </Disclosure>
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* CONDITION INSPECTOR                                             */}
      {/* ============================================================= */}

      {selectedCondition && (
        <InspectorShell
          title="Tracked Condition"
          icon={<Eye className="h-4 w-4 text-accent-text" />}
          onClose={() => setSelectedCondition(null)}
        >
          <InspectorField
            label="What the GOAT is watching"
            value={getSemanticConditionText(selectedCondition)}
          />

          <div className="grid grid-cols-2 gap-3">
            <InspectorField
              label="Market"
              value={selectedCondition.market}
              mono
            />

            <InspectorField
              label="State"
              value={
                selectedCondition.isTriggered
                  ? 'Triggered'
                  : 'Waiting'
              }
              mono
            />
          </div>

          <InspectorField
            label="Condition Type"
            value={selectedCondition.type}
            mono
          />

          <InspectorField
            label="What happens next"
            value="When the tracked event occurs, the GOAT is woken and reassesses the thesis using current market context."
          />
        </InspectorShell>
      )}

      {/* ============================================================= */}
      {/* WAKE EVENT INSPECTOR                                            */}
      {/* ============================================================= */}

      {selectedWakeEvent && (
        <InspectorShell
          title="Wake Event"
          icon={<Clock className="h-4 w-4 text-accent-text" />}
          onClose={() => setSelectedWakeEvent(null)}
        >
          <InspectorField
            label="Timestamp"
            value={new Date(
              selectedWakeEvent.timestamp
            ).toLocaleString()}
            mono
          />

          <InspectorField
            label="Trigger Reason"
            value={selectedWakeEvent.reason}
          />

          <InspectorField
            label="Observed Evidence"
            value={selectedWakeEvent.evidenceSnapshot}
          />

          <InspectorField
            label="Decision"
            value={selectedWakeEvent.decisionResult}
            mono
          />

          <InspectorField
            label="Outcome"
            value={selectedWakeEvent.details}
          />
        </InspectorShell>
      )}

      {/* ============================================================= */}
      {/* LEGACY REVIEW INSPECTOR — PRESERVED FOR COMPATIBILITY          */}
      {/* ============================================================= */}

      {selectedReview && (
        <InspectorShell
          title={selectedReview.session || 'Market Review'}
          icon={<Calendar className="h-4 w-4 text-accent-text" />}
          onClose={() => setSelectedReview(null)}
        >
          <InspectorField
            label="Market Reviewed"
            value={`${selectedReview.market || '—'} ${
              selectedReview.time
                ? `(${selectedReview.time})`
                : ''
            }`}
            mono
          />

          <InspectorField
            label="Thesis"
            value={selectedReview.thesis || '—'}
          />

          <InspectorField
            label="Major Evidence"
            value={selectedReview.evidence || '—'}
          />

          <InspectorField
            label="Changed Thinking?"
            value={selectedReview.changedThinking || '—'}
          />
        </InspectorShell>
      )}

      {/* ============================================================= */}
      {/* CHAT                                                            */}
      {/* ============================================================= */}

      {isChatOpen && inspectedGoat && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="flex h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-raised shadow-2xl sm:h-[700px] sm:max-w-xl sm:rounded-3xl">
            <div className="flex items-center justify-between border-b border-line bg-raised p-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/40 bg-accent-soft">
                  🐐
                </div>

                <div>
                  <h3 className="flex items-center gap-1.5 text-sm font-bold text-fg">
                    {inspectedGoat.name}
                    <span className="h-2 w-2 rounded-full bg-positive" />
                  </h3>

                  <p className="text-[10px] text-fg-subtle">
                    Grounded in live runtime state
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsChatOpen(false)}
                className="rounded-lg p-1 text-fg-subtle hover:text-fg"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-1.5 overflow-x-auto border-b border-line bg-sunken/50 px-4 py-2">
              {QUICK_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setChatQuestion(prompt)}
                  className="whitespace-nowrap rounded-full bg-raised px-2.5 py-1 text-[10px] text-fg-muted hover:text-accent-text"
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {chatMessages.map((message, index) => (
                <div
                  key={index}
                  className={`flex flex-col ${
                    message.sender === 'user'
                      ? 'items-end'
                      : 'items-start'
                  }`}
                >
                  <div
                    className={`max-w-[88%] whitespace-pre-wrap rounded-2xl p-3.5 text-xs leading-relaxed ${
                      message.sender === 'user'
                        ? 'rounded-tr-none bg-accent font-medium text-accent-fg'
                        : 'rounded-tl-none border border-line bg-sunken text-fg'
                    }`}
                  >
                    {message.text}
                  </div>

                  <span className="mt-1 px-1 text-[9px] font-mono text-fg-subtle">
                    {message.time}
                  </span>
                </div>
              ))}

              {isAsking && (
                <div className="flex items-center gap-2 rounded-xl border border-line bg-sunken/60 p-3 text-[10px] text-fg-subtle">
                  <span className="h-2 w-2 animate-ping rounded-full bg-accent" />
                  Consulting GOAT runtime...
                </div>
              )}
            </div>

            <form
              onSubmit={handleSendMessage}
              className="border-t border-line bg-surface p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  value={chatQuestion}
                  onChange={e =>
                    setChatQuestion(e.target.value)
                  }
                  placeholder={`Ask ${inspectedGoat.name}...`}
                  className="flex-1 rounded-xl border border-line bg-sunken px-3.5 py-2.5 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-focus"
                />

                <button
                  type="submit"
                  disabled={
                    isAsking || !chatQuestion.trim()
                  }
                  className="rounded-xl bg-accent p-2.5 text-accent-fg hover:bg-accent-hover disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* CREATE GOAT                                                    */}
      {/* ============================================================= */}

      {isOpenCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-4">
          <div className="max-h-[94vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-line bg-surface shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 p-5 backdrop-blur">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/40 bg-accent-soft">
                  <Sparkles className="h-4 w-4 text-accent-text" />
                </div>

                <div>
                  <h3 className="text-sm font-bold text-fg">
                    Create Your FundAGoat
                  </h3>

                  <p className="text-[10px] text-fg-subtle">
                    Give it the objective. The GOAT handles the reasoning loop.
                  </p>
                </div>
              </div>

              <button
                onClick={onCloseCreateModal}
                className="rounded-lg p-1 text-fg-subtle hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 sm:p-6">
              {createError && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border border-negative/40 bg-negative-soft p-3 text-xs text-negative">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{createError}</span>
                </div>
              )}

              <form
                onSubmit={handleCreateSubmit}
                className="space-y-5 text-xs"
              >
                {/* Identity */}
                <div>
                  <label className="mb-1.5 block font-semibold text-fg-muted">
                    GOAT Name
                  </label>

                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. London Alpha Hunter"
                    className="w-full rounded-xl border border-line bg-sunken px-3 py-2.5 text-fg outline-none placeholder:text-fg-subtle focus:border-focus"
                  />
                </div>

                {/* Goal */}
                <div>
                  <label className="mb-1.5 block font-semibold text-fg-muted">
                    Strategic Objective
                  </label>

                  <textarea
                    value={goal}
                    onChange={e => setGoal(e.target.value)}
                    rows={4}
                    placeholder="Describe what you want the GOAT to investigate and find."
                    className="w-full resize-none rounded-xl border border-line bg-sunken p-3 text-fg outline-none placeholder:text-fg-subtle focus:border-focus"
                  />

                  <p className="mt-1.5 text-[9px] leading-relaxed text-fg-subtle">
                    Focus on the outcome. Avoid hard-coding triggers or
                    timeframes — the GOAT determines what evidence it needs.
                  </p>
                </div>

                {/* Markets */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="font-semibold text-fg-muted">
                      Assigned Markets
                    </label>

                    <span className="text-[9px] font-mono text-fg-subtle">
                      {selectedMarkets.length} selected
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {symbols.map(symbol => {
                      const selected = selectedMarkets.includes(
                        symbol.symbol
                      );

                      return (
                        <button
                          key={symbol.symbol}
                          type="button"
                          onClick={() =>
                            toggleMarket(symbol.symbol)
                          }
                          className={`rounded-lg px-2.5 py-1.5 text-[10px] font-mono transition-colors ${
                            selected
                              ? 'bg-accent font-bold text-accent-fg'
                              : 'border border-line bg-sunken text-fg-muted hover:text-fg'
                          }`}
                        >
                          {symbol.symbol}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Skills */}
                <div>
                  <label className="mb-1.5 block font-semibold text-fg-muted">
                    Assigned Skills
                  </label>

                  <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                    {skills.map(skill => {
                      const selected =
                        selectedSkillIds.includes(skill.id);

                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => toggleSkill(skill.id)}
                          className={`flex w-full items-center justify-between rounded-xl border p-2.5 text-left transition-colors ${
                            selected
                              ? 'border-accent/40 bg-accent-soft text-fg'
                              : 'border-line bg-sunken text-fg-muted hover:text-fg'
                          }`}
                        >
                          <span className="font-semibold">
                            {skill.name}
                          </span>

                          {selected && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-accent-text" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* LIVE MODEL PICKER */}
                <div className="rounded-2xl border border-line bg-sunken/40 p-3.5">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <label className="block font-semibold text-fg">
                        Reasoning Model
                      </label>

                      <p className="mt-0.5 text-[9px] leading-relaxed text-fg-subtle">
                        Live catalogue. Models removed upstream are never
                        silently substituted.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void loadModels()}
                      disabled={modelState === 'loading'}
                      className="rounded-lg border border-line bg-sunken p-1.5 text-fg-subtle hover:text-fg disabled:opacity-40"
                      title="Refresh model catalogue"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${
                          modelState === 'loading'
                            ? 'animate-spin'
                            : ''
                        }`}
                      />
                    </button>
                  </div>

                  {modelState === 'loading' && (
                    <div className="flex items-center gap-2 rounded-xl border border-line bg-sunken p-3 text-[10px] text-fg-subtle">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin text-accent-text" />
                      Loading live reasoning models...
                    </div>
                  )}

                  {modelState === 'error' && (
                    <div className="rounded-xl border border-negative/30 bg-negative-soft/40 p-3">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 text-negative" />

                        <div className="flex-1">
                          <p className="text-[10px] text-negative">
                            {modelError}
                          </p>

                          <button
                            type="button"
                            onClick={() => void loadModels()}
                            className="mt-2 text-[10px] font-semibold text-accent-text hover:text-accent-text"
                          >
                            Retry catalogue
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {modelState === 'ready' && (
                    <>
                      <div className="mb-2 flex gap-2">
                        <input
                          value={modelSearch}
                          onChange={e =>
                            setModelSearch(e.target.value)
                          }
                          placeholder="Search models..."
                          className="min-w-0 flex-1 rounded-xl border border-line bg-sunken px-3 py-2 text-[10px] text-fg outline-none placeholder:text-fg-subtle focus:border-focus"
                        />

                        <button
                          type="button"
                          onClick={() =>
                            setShowModelDetails(v => !v)
                          }
                          className={`rounded-xl border px-2.5 text-[10px] ${
                            showModelDetails
                              ? 'border-accent/40 bg-accent-soft text-accent-text'
                              : 'border-line bg-sunken text-fg-subtle'
                          }`}
                        >
                          Info
                        </button>
                      </div>

                      {selectedModelIsUnavailable && (
                        <div className="mb-2 flex items-start gap-2 rounded-xl border border-negative/40 bg-negative-soft p-3">
                          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-negative" />

                          <div>
                            <p className="text-[10px] font-bold text-negative">
                              Selected model unavailable
                            </p>

                            <p className="mt-0.5 text-[9px] leading-relaxed text-negative/70">
                              {selectedModel} is no longer present in the
                              live catalogue. Select another model before
                              deploying.
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                        {filteredModels.map(model => {
                          const selected =
                            selectedModel === model.id;

                          const inputPrice = parsePricing(
                            model,
                            'input'
                          );

                          const outputPrice = parsePricing(
                            model,
                            'output'
                          );

                          return (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() =>
                                setSelectedModel(model.id)
                              }
                              className={`w-full rounded-xl border p-3 text-left transition-all ${
                                selected
                                  ? 'border-accent/50 bg-accent-soft'
                                  : 'border-line bg-sunken/70 hover:border-line-strong'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    {selected && (
                                      <Check className="h-3.5 w-3.5 shrink-0 text-accent-text" />
                                    )}

                                    <span className="truncate text-[11px] font-bold text-fg">
                                      {model.name}
                                    </span>
                                  </div>

                                  <p className="mt-0.5 truncate pl-5 text-[9px] font-mono text-fg-subtle">
                                    {model.id}
                                  </p>
                                </div>

                                <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[8px] font-mono text-fg-subtle">
                                  {formatContext(
                                    model.contextLength ||
                                      model.topProvider
                                        ?.contextLength
                                  )}{' '}
                                  ctx
                                </span>
                              </div>

                              {showModelDetails && (
                                <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/70 pt-2 text-[9px] font-mono text-fg-subtle">
                                  <span>
                                    Input:{' '}
                                    <strong className="text-fg-muted">
                                      {formatPrice(inputPrice)}
                                    </strong>
                                  </span>

                                  <span>
                                    Output:{' '}
                                    <strong className="text-fg-muted">
                                      {formatPrice(outputPrice)}
                                    </strong>
                                  </span>
                                </div>
                              )}
                            </button>
                          );
                        })}

                        {!filteredModels.length && (
                          <div className="py-6 text-center text-[10px] text-fg-subtle">
                            No live models match "{modelSearch}".
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Reasoning interval */}
                <div className="space-y-3 border-t border-line pt-4">
                  <div>
                    <label className="flex items-center gap-2 text-xs font-bold text-fg">
                      <Clock className="h-4 w-4 text-accent-text" />
                      Analysis Interval
                    </label>

                    <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
                      How often the AI is allowed to re-analyse the market.
                      Deterministic trackers keep checking conditions on every
                      price tick regardless — this only controls AI spend.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {SCHEDULE_PRESETS.map(preset => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          setSchedulePreset(
                            String(preset.minutes)
                          )
                        }
                        className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors cursor-pointer ${
                          schedulePreset ===
                          String(preset.minutes)
                            ? 'border-accent/50 bg-accent-soft text-accent-text'
                            : 'border-line bg-sunken text-fg-muted hover:border-line-strong'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}

                    <button
                      type="button"
                      onClick={() =>
                        setSchedulePreset('TIMES')
                      }
                      className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors cursor-pointer ${
                        schedulePreset === 'TIMES'
                          ? 'border-accent/50 bg-accent-soft text-accent-text'
                          : 'border-line bg-sunken text-fg-muted hover:border-line-strong'
                      }`}
                    >
                      Specific times
                    </button>
                  </div>

                  {schedulePreset === 'TIMES' && (
                    <div className="space-y-2 rounded-xl border border-line bg-sunken/60 p-3">
                      <p className="text-[10px] text-fg-muted">
                        Your local wall-clock times (24h). The AI analyses at
                        each one.
                      </p>

                      <div className="flex flex-wrap gap-2">
                        {customTimes.map((time, index) => (
                          <div
                            key={`${index}-${time}`}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="time"
                              value={time}
                              onChange={event => {
                                const next = [
                                  ...customTimes,
                                ];
                                next[index] =
                                  event.target.value;
                                setCustomTimes(next);
                              }}
                              className="rounded-lg border border-line bg-sunken px-2 py-1 text-[11px] font-mono text-fg focus:border-focus focus:outline-none"
                            />

                            {customTimes.length > 1 && (
                              <button
                                type="button"
                                aria-label="Remove time"
                                onClick={() =>
                                  setCustomTimes(
                                    customTimes.filter(
                                      (_, i) => i !== index
                                    )
                                  )
                                }
                                className="rounded-md p-1 text-fg-subtle hover:text-negative cursor-pointer"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}

                        {customTimes.length < 12 && (
                          <button
                            type="button"
                            onClick={() =>
                              setCustomTimes([
                                ...customTimes,
                                '12:00',
                              ])
                            }
                            className="rounded-lg border border-dashed border-line-strong px-2 py-1 text-[10px] font-semibold text-fg-muted hover:border-accent/40 hover:text-accent-text cursor-pointer"
                          >
                            + Add time
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <p className="text-[10px] font-mono text-fg-subtle">
                    Selected: {describeScheduleLabel(buildSchedule())}
                  </p>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
                  <div className="hidden text-[9px] leading-relaxed text-fg-subtle sm:block">
                    The GOAT decides when conditions are sufficient.
                    You define the objective.
                  </div>

                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={onCloseCreateModal}
                      className="rounded-xl px-4 py-2 text-xs font-semibold text-fg-subtle hover:text-fg"
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      disabled={
                        isCreating ||
                        modelState !== 'ready' ||
                        !selectedModel ||
                        selectedModelIsUnavailable
                      }
                      className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2 text-xs font-bold text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isCreating ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          Deploying...
                        </>
                      ) : (
                        <>
                          <Zap className="h-3.5 w-3.5" />
                          Deploy GOAT
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ================================================================== */
/* SMALL REUSABLE VIEW PRIMITIVES                                     */
/* ================================================================== */

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const Disclosure: React.FC<DisclosureProps> = ({
  open,
  onToggle,
  title,
  subtitle,
  icon,
  children,
}) => (
  <section className="overflow-hidden rounded-2xl border border-line bg-surface">
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-sunken/50"
    >
      <div className="flex items-center gap-2.5">
        {open ? (
          <ChevronUp className="h-4 w-4 text-accent-text" />
        ) : (
          <ChevronDown className="h-4 w-4 text-fg-subtle" />
        )}

        <span className="text-accent-text">{icon}</span>

        <div>
          <h4 className="text-xs font-bold text-fg">
            {title}
          </h4>

          <p className="text-[9px] font-mono text-fg-subtle">
            {subtitle}
          </p>
        </div>
      </div>

      <span className="text-[10px] text-fg-subtle">
        {open ? 'Hide' : 'Inspect'}
      </span>
    </button>

    {open && (
      <div className="space-y-2 border-t border-line p-4">
        {children}
      </div>
    )}
  </section>
);

const EmptyDisclosure: React.FC<{ text: string }> = ({
  text,
}) => (
  <div className="py-7 text-center text-[10px] text-fg-subtle">
    {text}
  </div>
);

interface EvidenceListProps {
  title: string;
  tone: 'positive' | 'negative';
  items: string[];
}

const EvidenceList: React.FC<EvidenceListProps> = ({
  title,
  tone,
  items,
}) => (
  <div>
    <span
      className={`mb-2 block text-[9px] font-bold uppercase tracking-wider ${
        tone === 'positive'
          ? 'text-positive'
          : 'text-negative'
      }`}
    >
      {title}
    </span>

    {items.length ? (
      <ul className="space-y-1.5">
        {items.map((item, index) => (
          <li
            key={`${title}-${index}`}
            className="rounded-lg border border-line/70 bg-sunken/50 px-3 py-2 text-[10px] leading-relaxed text-fg-muted"
          >
            {item}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-[10px] text-fg-subtle">
        Nothing recorded.
      </p>
    )}
  </div>
);

interface InspectorShellProps {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

const InspectorShell: React.FC<InspectorShellProps> = ({
  title,
  icon,
  onClose,
  children,
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
    <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl">
      <div className="flex items-center justify-between border-b border-line p-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-fg">
          {icon}
          {title}
        </h3>

        <button
          onClick={onClose}
          className="rounded-lg p-1 text-fg-subtle hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-5">
        {children}
      </div>

      <div className="flex justify-end border-t border-line p-4">
        <button
          onClick={onClose}
          className="rounded-xl bg-sunken px-4 py-2 text-xs font-semibold text-fg-muted hover:bg-raised"
        >
          Close
        </button>
      </div>
    </div>
  </div>
);

interface InspectorFieldProps {
  label: string;
  value: string;
  mono?: boolean;
}

const InspectorField: React.FC<InspectorFieldProps> = ({
  label,
  value,
  mono = false,
}) => (
  <div>
    <span className="block text-[9px] font-bold uppercase tracking-wider text-fg-subtle">
      {label}
    </span>

    <p
      className={`mt-1 text-xs leading-relaxed text-fg-muted ${
        mono ? 'font-mono' : ''
      }`}
    >
      {value || '—'}
    </p>
  </div>
);