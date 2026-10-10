import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DataMode,
  GoatRuntimeState,
  GoatSchedule,
  FundGoat,
  TradingSkill,
} from '../types';

import { useAuth } from './AuthContext';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateGoatInput {
  name: string;
  goal: string;
  markets: string[];
  skillIds: string[];
  model: string;
  schedule?: GoatSchedule;
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  methodology?: string;
  constraints?: string;
  preferredTimeframes?: string[];
  requiredEvidence?: string;
  invalidationRules?: string;
  rawMarkdown?: string;
}

interface GoatWithRuntimeState extends FundGoat {
  runtimeState?: GoatRuntimeState | null;
}

interface GoatsResponse {
  goats: GoatWithRuntimeState[];
  dataMode?: DataMode;
}

interface GoatResponse {
  goat: FundGoat;
  runtimeState?: GoatRuntimeState | null;
  dataMode?: DataMode;
}

interface SkillsResponse {
  skills: TradingSkill[];
  dataMode?: DataMode;
}

interface SkillResponse {
  skill: TradingSkill;
  dataMode?: DataMode;
}

interface WakeResponse {
  state: GoatRuntimeState;
  dataMode?: DataMode;
}

interface StatusResponse {
  goat: FundGoat;
  status: FundGoat['status'];
  runtimeState?: GoatRuntimeState;
  schedule?: GoatSchedule;
  dataMode?: DataMode;
}

interface ScheduleResponse {
  goat: FundGoat;
  schedule: GoatSchedule;
  dataMode?: DataMode;
}

interface ChatResponse {
  answer?: string;
}

interface ApiErrorBody {
  error?:
    | string
    | {
        message?: string;
        code?: string;
      };
  message?: string;
  code?: string;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

interface GoatContextType {
  goats: FundGoat[];
  activeGoat: FundGoat | null;
  activeGoatId: string;
  activeGoatState: GoatRuntimeState | null;

  skills: TradingSkill[];

  dataMode: DataMode | null;

  loading: boolean;
  error: string | null;
  isWaking: boolean;

  setActiveGoatId: (id: string) => void;

  createGoat: (data: CreateGoatInput) => Promise<FundGoat>;

  /** Stop ("PAUSE") or resume ("PLAY") a GOAT's runtime. */
  setGoatStatus: (
    goatId: string,
    action: 'PAUSE' | 'PLAY'
  ) => Promise<FundGoat>;

  /** Permanently remove a GOAT and its runtime. */
  deleteGoat: (goatId: string) => Promise<void>;

  /** Change how often a GOAT is allowed to run AI reasoning. */
  setGoatSchedule: (
    goatId: string,
    schedule: GoatSchedule
  ) => Promise<GoatSchedule>;

  /** Ids with an in-flight status/schedule/delete request. */
  busyGoatIds: string[];

  createSkill: (data: CreateSkillInput) => Promise<TradingSkill>;

  deleteSkill: (id: string) => Promise<void>;

  wakeActiveGoat: (
    reason?: string
  ) => Promise<GoatRuntimeState | null>;

  askActiveGoat: (question: string) => Promise<string>;

  refreshGoats: () => Promise<void>;

  refreshSkills: () => Promise<void>;

  refreshActiveGoatState: () => Promise<void>;

  clearError: () => void;
}

const GoatContext = createContext<GoatContextType | undefined>(undefined);

/* -------------------------------------------------------------------------- */
/* API errors                                                                 */
/* -------------------------------------------------------------------------- */

class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    code?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

function extractApiError(
  body: ApiErrorBody | null,
  fallback: string
): {
  message: string;
  code?: string;
} {
  if (!body) {
    return {
      message: fallback,
    };
  }

  if (typeof body.error === 'string') {
    return {
      message: body.error,
      code: body.code,
    };
  }

  if (body.error && typeof body.error === 'object') {
    return {
      message:
        body.error.message ||
        body.message ||
        fallback,
      code:
        body.error.code ||
        body.code,
    };
  }

  return {
    message: body.message || fallback,
    code: body.code,
  };
}

async function requestJson<T>(
  path: string,
  getApiAuthHeaders: () => Promise<Record<string, string>>,
  init: RequestInit = {}
): Promise<T> {
  const authHeaders = await getApiAuthHeaders();

  const headers = new Headers(init.headers);

  headers.set('Accept', 'application/json');

  for (const [key, value] of Object.entries(authHeaders)) {
    headers.set(key, value);
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let body: ApiErrorBody | null = null;

    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Response wasn't JSON.
    }

    const fallback =
      response.status === 401
        ? 'Authentication required.'
        : response.status === 403
          ? 'You do not have permission to perform this action.'
          : `Request failed (${response.status}).`;

    const parsed = extractApiError(body, fallback);

    throw new ApiRequestError(
      parsed.message,
      response.status,
      parsed.code
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiRequestError(
      'The server returned an invalid response.',
      response.status,
      'INVALID_JSON'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function requireNonEmpty(
  value: string,
  field: string
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${field} is required.`);
  }

  return trimmed;
}

function cleanStringArray(
  values: string[] | undefined
): string[] {
  if (!values) return [];

  return [
    ...new Set(
      values
        .map(value => value.trim())
        .filter(Boolean)
    ),
  ];
}

function isDataMode(value: unknown): value is DataMode {
  return value === 'PAPER' || value === 'LIVE';
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export const GoatProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const {
    canQueryApi,
    loading: authLoading,
    getApiAuthHeaders,
  } = useAuth();

  const [goats, setGoats] = useState<FundGoat[]>([]);
  const [activeGoatId, setActiveGoatIdState] = useState('');
  const [activeGoatState, setActiveGoatState] =
    useState<GoatRuntimeState | null>(null);

  const [skills, setSkills] = useState<TradingSkill[]>([]);

  const [dataMode, setDataMode] =
    useState<DataMode | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isWaking, setIsWaking] = useState(false);
  const [busyGoatIds, setBusyGoatIds] = useState<string[]>([]);

  /* ------------------------------------------------------------------------ */
  /* Refs                                                                     */
  /* ------------------------------------------------------------------------ */

  const mountedRef = useRef(true);

  const sessionRef = useRef(0);

  const activeGoatIdRef = useRef('');

  const isWakingRef = useRef(false);

  /*
   * AuthContext can recreate getApiAuthHeaders during renders.
   * Keeping the latest function in a ref allows the API helper to remain
   * stable and prevents unnecessary effect/polling churn.
   */
  const getApiAuthHeadersRef =
    useRef(getApiAuthHeaders);

  getApiAuthHeadersRef.current =
    getApiAuthHeaders;

  activeGoatIdRef.current = activeGoatId;

  /* ------------------------------------------------------------------------ */
  /* Lifecycle                                                                */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
    };
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Stable API request                                                        */
  /* ------------------------------------------------------------------------ */

  const apiRequest = useCallback(
    async <T,>(
      path: string,
      init: RequestInit = {}
    ): Promise<T> => {
      return requestJson<T>(
        path,
        () => getApiAuthHeadersRef.current(),
        init
      );
    },
    []
  );

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  const isCurrentSession = useCallback(
    (sessionId: number): boolean => {
      return (
        mountedRef.current &&
        sessionRef.current === sessionId
      );
    },
    []
  );

  const setRequestError = useCallback(
    (
      requestError: unknown,
      fallback: string
    ) => {
      const message =
        requestError instanceof Error
          ? requestError.message
          : fallback;

      if (mountedRef.current) {
        setError(message);
      }

      return message;
    },
    []
  );

  const mergeRuntimeStateIntoGoat = useCallback(
    (
      goatId: string,
      runtimeState: GoatRuntimeState
    ) => {
      setGoats(previous =>
        previous.map(goat => {
          if (goat.id !== goatId) {
            return goat;
          }

          return {
            ...goat,
            status: runtimeState.status,
            lastWakeReason:
              runtimeState.lastWakeEvent?.reason ??
              goat.lastWakeReason,
            lastWakeTime:
              runtimeState.lastWakeEvent
                ? new Date(
                    runtimeState.lastWakeEvent.timestamp
                  ).toISOString()
                : goat.lastWakeTime,
          };
        })
      );
    },
    []
  );

  /* ------------------------------------------------------------------------ */
  /* Select active GOAT                                                       */
  /* ------------------------------------------------------------------------ */

  const setActiveGoatId = useCallback(
    (id: string) => {
      const nextId = id.trim();

      activeGoatIdRef.current = nextId;

      setActiveGoatIdState(nextId);

      /*
       * Never display the previous GOAT's runtime state while the new
       * GOAT's state is loading.
       */
      setActiveGoatState(null);

      setError(null);
    },
    []
  );

  /* ------------------------------------------------------------------------ */
  /* Refresh GOATs                                                             */
  /* ------------------------------------------------------------------------ */

  const refreshGoats = useCallback(
    async (): Promise<void> => {
      if (!canQueryApi) {
        return;
      }

      const sessionId = sessionRef.current;

      try {
        const data =
          await apiRequest<GoatsResponse>(
            '/api/goats'
          );

        if (!isCurrentSession(sessionId)) {
          return;
        }

        const nextGoats = Array.isArray(data.goats)
          ? data.goats
          : [];

        setGoats(nextGoats);

        if (isDataMode(data.dataMode)) {
          setDataMode(data.dataMode);
        }

        const currentId =
          activeGoatIdRef.current;

        const currentStillExists =
          currentId.length > 0 &&
          nextGoats.some(
            goat => goat.id === currentId
          );

        const nextActiveId = currentStillExists
          ? currentId
          : nextGoats[0]?.id || '';

        activeGoatIdRef.current =
          nextActiveId;

        setActiveGoatIdState(nextActiveId);

        const selectedGoat =
          nextGoats.find(
            goat => goat.id === nextActiveId
          );

        /*
         * Only replace runtime state if the selected GOAT changed or
         * the list actually supplied runtime state.
         */
        if (
          nextActiveId !== currentId ||
          selectedGoat?.runtimeState !== undefined
        ) {
          setActiveGoatState(
            selectedGoat?.runtimeState ?? null
          );
        }

        if (!nextActiveId) {
          setActiveGoatState(null);
        }
      } catch (requestError) {
        if (!isCurrentSession(sessionId)) {
          return;
        }

        setRequestError(
          requestError,
          'Failed to load GOATs.'
        );
      }
    },
    [
      apiRequest,
      canQueryApi,
      isCurrentSession,
      setRequestError,
    ]
  );

  /* ------------------------------------------------------------------------ */
  /* Refresh skills                                                            */
  /* ------------------------------------------------------------------------ */

  const refreshSkills = useCallback(
    async (): Promise<void> => {
      if (!canQueryApi) {
        return;
      }

      const sessionId = sessionRef.current;

      try {
        const data =
          await apiRequest<SkillsResponse>(
            '/api/skills'
          );

        if (!isCurrentSession(sessionId)) {
          return;
        }

        const nextSkills = Array.isArray(data.skills)
          ? data.skills
          : [];

        setSkills(nextSkills);

        if (isDataMode(data.dataMode)) {
          setDataMode(data.dataMode);
        }
      } catch (requestError) {
        if (!isCurrentSession(sessionId)) {
          return;
        }

        setRequestError(
          requestError,
          'Failed to load skills.'
        );
      }
    },
    [
      apiRequest,
      canQueryApi,
      isCurrentSession,
      setRequestError,
    ]
  );

  /* ------------------------------------------------------------------------ */
  /* Fetch active GOAT runtime state                                          */
  /* ------------------------------------------------------------------------ */

  const fetchActiveGoatState = useCallback(
    async (
      goatId: string
    ): Promise<void> => {
      const id = goatId.trim();

      if (
        !id ||
        authLoading ||
        !canQueryApi
      ) {
        return;
      }

      const sessionId = sessionRef.current;

      try {
        const data =
          await apiRequest<GoatResponse>(
            `/api/goats/${encodeURIComponent(id)}`
          );

        if (!isCurrentSession(sessionId)) {
          return;
        }

        /*
         * A request for an old GOAT must never overwrite the currently
         * selected GOAT's state.
         */
        if (
          activeGoatIdRef.current !== id
        ) {
          return;
        }

        if (data.runtimeState) {
          setActiveGoatState(
            data.runtimeState
          );

          mergeRuntimeStateIntoGoat(
            id,
            data.runtimeState
          );
        }

        if (isDataMode(data.dataMode)) {
          setDataMode(data.dataMode);
        }
      } catch (requestError) {
        if (!isCurrentSession(sessionId)) {
          return;
        }

        /*
         * Don't wipe the currently visible state because one background
         * polling request failed.
         */
        console.warn(
          'Active GOAT state fetch failed:',
          requestError
        );
      }
    },
    [
      apiRequest,
      canQueryApi,
      isCurrentSession,
      mergeRuntimeStateIntoGoat,
    ]
  );

  const refreshActiveGoatState =
    useCallback(async (): Promise<void> => {
      const id = activeGoatIdRef.current;

      if (!id) {
        return;
      }

      await fetchActiveGoatState(id);
    }, [fetchActiveGoatState]);

  /* ------------------------------------------------------------------------ */
  /* Auth/user lifecycle                                                       */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    /*
     * Every auth transition creates a new logical session.
     * Old requests are therefore unable to write into the new user's state.
     */
    sessionRef.current += 1;

    const sessionId = sessionRef.current;

    setError(null);

    setGoats([]);
    setSkills([]);

    activeGoatIdRef.current = '';

    setActiveGoatIdState('');
    setActiveGoatState(null);

    setDataMode(null);

    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!canQueryApi) {
      setLoading(false);
      return;
    }

    setLoading(true);

    void Promise.allSettled([
      refreshGoats(),
      refreshSkills(),
    ]).finally(() => {
      if (
        mountedRef.current &&
        sessionRef.current === sessionId
      ) {
        setLoading(false);
      }
    });
  }, [
    canQueryApi,
    refreshGoats,
    refreshSkills,
  ]);

  /* ------------------------------------------------------------------------ */
  /* Runtime polling                                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (
      authLoading ||
      !canQueryApi ||
      !activeGoatId
    ) {
      return;
    }

    let stopped = false;
    let requestInFlight = false;

    const poll = async () => {
      if (
        stopped ||
        requestInFlight ||
        document.visibilityState !== 'visible'
      ) {
        return;
      }

      requestInFlight = true;

      try {
        await fetchActiveGoatState(
          activeGoatId
        );
      } finally {
        requestInFlight = false;
      }
    };

    void poll();

    const interval = window.setInterval(
      () => {
        void poll();
      },
      5000
    );

    const handleVisibilityChange = () => {
      if (
        document.visibilityState ===
        'visible'
      ) {
        void poll();
      }
    };

    document.addEventListener(
      'visibilitychange',
      handleVisibilityChange
    );

    return () => {
      stopped = true;

      window.clearInterval(interval);

      document.removeEventListener(
        'visibilitychange',
        handleVisibilityChange
      );
    };
  }, [
    activeGoatId,
    canQueryApi,
    fetchActiveGoatState,
  ]);

  /* ------------------------------------------------------------------------ */
  /* Create GOAT                                                               */
  /* ------------------------------------------------------------------------ */

  const createGoat = useCallback(
    async (
      input: CreateGoatInput
    ): Promise<FundGoat> => {
      const name = requireNonEmpty(
        input.name,
        'GOAT name'
      );

      const goal = requireNonEmpty(
        input.goal,
        'GOAT goal'
      );

      const model = requireNonEmpty(
        input.model,
        'Model'
      );

      const markets =
        cleanStringArray(input.markets);

      const skillIds =
        cleanStringArray(input.skillIds);

      if (markets.length === 0) {
        throw new Error(
          'At least one market is required.'
        );
      }

      const sessionId = sessionRef.current;

      try {
        const data =
          await apiRequest<GoatResponse>(
            '/api/goats',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                name,
                goal,
                markets,
                skillIds,
                model,
                ...(input.schedule
                  ? { schedule: input.schedule }
                  : {}),
              }),
            }
          );

        if (!data?.goat?.id) {
          throw new Error(
            'The server did not return the created GOAT.'
          );
        }

        if (!isCurrentSession(sessionId)) {
          return data.goat;
        }

        setGoats(previous => {
          const withoutCreatedGoat =
            previous.filter(
              goat =>
                goat.id !== data.goat.id
            );

          return [
            ...withoutCreatedGoat,
            data.goat,
          ];
        });

        activeGoatIdRef.current =
          data.goat.id;

        setActiveGoatIdState(
          data.goat.id
        );

        setActiveGoatState(
          data.runtimeState ?? null
        );

        if (
          isDataMode(data.dataMode)
        ) {
          setDataMode(data.dataMode);
        }

        setError(null);

        return data.goat;
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to create FundAGoat.'
        );

        throw requestError;
      }
    },
    [
      apiRequest,
      isCurrentSession,
      setRequestError,
    ]
  );

  /* ------------------------------------------------------------------------ */
  /* Stop / Play / schedule / delete                                        */
  /* ------------------------------------------------------------------------ */

  const markGoatBusy = useCallback(
    (goatId: string, busy: boolean) => {
      if (!mountedRef.current) return;

      setBusyGoatIds(previous =>
        busy
          ? previous.includes(goatId)
            ? previous
            : [...previous, goatId]
          : previous.filter(id => id !== goatId)
      );
    },
    []
  );

  const setGoatStatus = useCallback(
    async (
      goatId: string,
      action: 'PAUSE' | 'PLAY'
    ): Promise<FundGoat> => {
      const id = goatId.trim();

      if (!id) {
        throw new Error('GOAT ID is required.');
      }

      markGoatBusy(id, true);

      try {
        const data = await apiRequest<StatusResponse>(
          `/api/goats/${encodeURIComponent(id)}/status`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ action }),
          }
        );

        if (data?.goat?.id) {
          setGoats(previous =>
            previous.map(goat =>
              goat.id === id
                ? {
                    ...goat,
                    status: data.goat.status,
                    schedule:
                      data.schedule ?? data.goat.schedule,
                  }
                : goat
            )
          );

          if (
            activeGoatIdRef.current === id &&
            data.runtimeState
          ) {
            setActiveGoatState(data.runtimeState);
          }

          if (isDataMode(data.dataMode)) {
            setDataMode(data.dataMode);
          }
        }

        setError(null);

        return data.goat;
      } catch (requestError) {
        setRequestError(
          requestError,
          action === 'PAUSE'
            ? 'Failed to stop GOAT.'
            : 'Failed to resume GOAT.'
        );

        throw requestError;
      } finally {
        markGoatBusy(id, false);
      }
    },
    [apiRequest, markGoatBusy, setRequestError]
  );

  const deleteGoat = useCallback(
    async (goatId: string): Promise<void> => {
      const id = goatId.trim();

      if (!id) {
        throw new Error('GOAT ID is required.');
      }

      markGoatBusy(id, true);

      try {
        await apiRequest<void>(
          `/api/goats/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        );

        if (!mountedRef.current) return;

        const wasActive = activeGoatIdRef.current === id;

        setGoats(previous =>
          previous.filter(goat => goat.id !== id)
        );

        if (wasActive) {
          setActiveGoatState(null);
          setError(null);
        }

        // Re-select so the UI never shows a deleted GOAT.
        await refreshGoats();
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to delete GOAT.'
        );

        throw requestError;
      } finally {
        markGoatBusy(id, false);
      }
    },
    [apiRequest, markGoatBusy, refreshGoats, setRequestError]
  );

  const setGoatSchedule = useCallback(
    async (
      goatId: string,
      schedule: GoatSchedule
    ): Promise<GoatSchedule> => {
      const id = goatId.trim();

      if (!id) {
        throw new Error('GOAT ID is required.');
      }

      markGoatBusy(id, true);

      try {
        const data = await apiRequest<ScheduleResponse>(
          `/api/goats/${encodeURIComponent(id)}/schedule`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ schedule }),
          }
        );

        const effective =
          data.schedule ?? schedule;

        setGoats(previous =>
          previous.map(goat =>
            goat.id === id
              ? { ...goat, schedule: effective }
              : goat
          )
        );

        setError(null);

        return effective;
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to update the analysis schedule.'
        );

        throw requestError;
      } finally {
        markGoatBusy(id, false);
      }
    },
    [apiRequest, markGoatBusy, setRequestError]
  );

  /* ------------------------------------------------------------------------ */
  /* Create skill                                                              */
  /* ------------------------------------------------------------------------ */

  const createSkill = useCallback(
    async (
      input: CreateSkillInput
    ): Promise<TradingSkill> => {
      const name = requireNonEmpty(
        input.name,
        'Skill name'
      );

      const payload: CreateSkillInput = {
        name,
        description:
          input.description?.trim() || '',
        methodology:
          input.methodology?.trim() || '',
        constraints:
          input.constraints?.trim() || '',
        preferredTimeframes:
          cleanStringArray(
            input.preferredTimeframes
          ),
        requiredEvidence:
          input.requiredEvidence?.trim() || '',
        invalidationRules:
          input.invalidationRules?.trim() || '',
        rawMarkdown:
          input.rawMarkdown?.trim() || '',
      };

      const sessionId = sessionRef.current;

      try {
        const data =
          await apiRequest<SkillResponse>(
            '/api/skills',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify(payload),
            }
          );

        if (!data?.skill?.id) {
          throw new Error(
            'The server did not return the created skill.'
          );
        }

        if (!isCurrentSession(sessionId)) {
          return data.skill;
        }

        setSkills(previous => {
          const withoutCreatedSkill =
            previous.filter(
              skill =>
                skill.id !== data.skill.id
            );

          return [
            ...withoutCreatedSkill,
            data.skill,
          ];
        });

        if (
          isDataMode(data.dataMode)
        ) {
          setDataMode(data.dataMode);
        }

        setError(null);

        return data.skill;
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to create skill.'
        );

        throw requestError;
      }
    },
    [
      apiRequest,
      isCurrentSession,
      setRequestError,
    ]
  );

  /* ------------------------------------------------------------------------ */
  /* Delete skill                                                              */
  /* ------------------------------------------------------------------------ */

  const deleteSkill = useCallback(
    async (id: string): Promise<void> => {
      const skillId = id.trim();

      if (!skillId) {
        throw new Error(
          'Skill ID is required.'
        );
      }

      try {
        await apiRequest<void>(
          `/api/skills/${encodeURIComponent(
            skillId
          )}`,
          {
            method: 'DELETE',
          }
        );

        if (!mountedRef.current) {
          return;
        }

        setSkills(previous =>
          previous.filter(
            skill => skill.id !== skillId
          )
        );

        setError(null);
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to delete skill.'
        );

        throw requestError;
      }
    },
    [apiRequest, setRequestError]
  );

  /* ------------------------------------------------------------------------ */
  /* Wake active GOAT                                                          */
  /* ------------------------------------------------------------------------ */

  const wakeActiveGoat = useCallback(
    async (
      reason?: string
    ): Promise<GoatRuntimeState | null> => {
      const goatId =
        activeGoatIdRef.current;

      if (!goatId) {
        return null;
      }

      if (isWakingRef.current) {
        throw new Error(
          'This GOAT is already waking.'
        );
      }

      isWakingRef.current = true;
      setIsWaking(true);

      const sessionId = sessionRef.current;

      const wakeReason =
        reason?.trim() ||
        'Manual user wake request';

      try {
        const data =
          await apiRequest<WakeResponse>(
            `/api/goats/${encodeURIComponent(
              goatId
            )}/wake`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                reason: wakeReason,
              }),
            }
          );

        if (!data?.state) {
          throw new Error(
            'The server did not return GOAT runtime state.'
          );
        }

        /*
         * The wake request may finish after the user has selected another
         * GOAT. Never put the old result into the new GOAT's state.
         */
        if (
          isCurrentSession(sessionId) &&
          activeGoatIdRef.current === goatId
        ) {
          setActiveGoatState(data.state);

          mergeRuntimeStateIntoGoat(
            goatId,
            data.state
          );

          if (
            isDataMode(data.dataMode)
          ) {
            setDataMode(data.dataMode);
          }

          setError(null);
        }

        return data.state;
      } catch (requestError) {
        setRequestError(
          requestError,
          'Failed to wake GOAT.'
        );

        throw requestError;
      } finally {
        isWakingRef.current = false;

        if (mountedRef.current) {
          setIsWaking(false);
        }
      }
    },
    [
      apiRequest,
      isCurrentSession,
      mergeRuntimeStateIntoGoat,
      setRequestError,
    ]
  );

  /* ------------------------------------------------------------------------ */
  /* Ask active GOAT                                                           */
  /* ------------------------------------------------------------------------ */

  const askActiveGoat = useCallback(
    async (
      question: string
    ): Promise<string> => {
      const goatId =
        activeGoatIdRef.current;

      if (!goatId) {
        return 'No active GOAT available.';
      }

      const cleanedQuestion =
        question.trim();

      if (!cleanedQuestion) {
        throw new Error(
          'Question cannot be empty.'
        );
      }

      try {
        const data =
          await apiRequest<ChatResponse>(
            `/api/goats/${encodeURIComponent(
              goatId
            )}/chat`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                question:
                  cleanedQuestion,
              }),
            }
          );

        if (
          typeof data.answer !==
          'string' ||
          !data.answer.trim()
        ) {
          return 'No response from GOAT.';
        }

        return data.answer;
      } catch (requestError) {
        setRequestError(
          requestError,
          'GOAT chat failed.'
        );

        throw requestError;
      }
    },
    [apiRequest, setRequestError]
  );

  /* ------------------------------------------------------------------------ */
  /* Clear error                                                               */
  /* ------------------------------------------------------------------------ */

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Derived state                                                             */
  /* ------------------------------------------------------------------------ */

  const activeGoat = useMemo(() => {
    if (!activeGoatId) {
      return null;
    }

    return (
      goats.find(
        goat => goat.id === activeGoatId
      ) ?? null
    );
  }, [activeGoatId, goats]);

  /* ------------------------------------------------------------------------ */
  /* Context value                                                             */
  /* ------------------------------------------------------------------------ */

  const contextValue = useMemo<GoatContextType>(
    () => ({
      goats,
      activeGoat,
      activeGoatId,
      activeGoatState,

      skills,

      dataMode,

      loading,
      error,
      isWaking,

      setActiveGoatId,

      createGoat,
      setGoatStatus,
      deleteGoat,
      setGoatSchedule,
      busyGoatIds,

      createSkill,
      deleteSkill,

      wakeActiveGoat,
      askActiveGoat,

      refreshGoats,
      refreshSkills,
      refreshActiveGoatState,

      clearError,
    }),
    [
      goats,
      activeGoat,
      activeGoatId,
      activeGoatState,
      skills,
      dataMode,
      loading,
      error,
      isWaking,
      busyGoatIds,
      setActiveGoatId,
      createGoat,
      setGoatStatus,
      deleteGoat,
      setGoatSchedule,
      createSkill,
      deleteSkill,
      wakeActiveGoat,
      askActiveGoat,
      refreshGoats,
      refreshSkills,
      refreshActiveGoatState,
      clearError,
    ]
  );

  return (
    <GoatContext.Provider value={contextValue}>
      {children}
    </GoatContext.Provider>
  );
};

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export const useGoat = (): GoatContextType => {
  const context = useContext(GoatContext);

  if (!context) {
    throw new Error(
      'useGoat must be used within a GoatProvider'
    );
  }

  return context;
};