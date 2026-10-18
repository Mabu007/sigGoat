/**
 * THEME
 * =====
 * A real two-theme system: light and dark are each designed, not one
 * inverted into the other.
 *
 * WHERE THE INITIAL THEME IS DECIDED
 *   In `index.html`, synchronously, before the bundle loads. This provider
 *   READS that decision rather than making one on first render, because a
 *   React effect runs after the browser has already painted — which shows up
 *   as a flash of the wrong theme on every page load.
 *
 * DEFAULT
 *   Dark is the product default. An explicit user choice is remembered and
 *   always wins on subsequent visits.
 *
 * PERSISTENCE
 *   `localStorage`, with a hardcoded default if storage is unavailable
 *   (private browsing throws on access). The key is namespaced to this
 *   product so it cannot collide with anything else on the origin.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sirgoat.theme';
/** Pre-rename key, read once so a rename never silently resets a user's theme. */
const LEGACY_STORAGE_KEY = 'fundagoat.theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /**
   * False until the stored preference has been read on the client.
   *
   * Consumers that render colour-dependent chrome can use this to avoid
   * painting twice. The root layout does not need it, because the pre-paint
   * script has already set `data-theme`.
   */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads the theme the pre-paint script already applied. */
function readAppliedTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function readStoredPreference(): Theme | null {
  try {
    /**
     * The legacy key is consulted so renaming the product cannot silently
     * reset a returning user's theme to the OS default — a small thing, but
     * it is exactly the kind of surprise a rename should never cause.
     */
    const stored =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Private browsing / storage disabled. The dark product default remains.
    return null;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Starts from what is ALREADY on <html>, so the first render matches the
  // painted DOM exactly and React does not correct it.
  const [theme, setThemeState] = useState<Theme>(() => readAppliedTheme());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  const applyTheme = useCallback((next: Theme) => {
    setThemeState(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable. The theme still applies for this session; it
      // just will not be remembered next time.
    }
  }, []);

  const setTheme = useCallback(
    (next: Theme) => applyTheme(next),
    [applyTheme],
  );

  const toggleTheme = useCallback(
    () => applyTheme(readAppliedTheme() === 'dark' ? 'light' : 'dark'),
    [applyTheme],
  );

  /** First visit defaults to dark; saved light/dark preferences are respected. */
  useEffect(() => {
    if (readStoredPreference() !== null) return;
    setThemeState('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme, ready }),
    [theme, setTheme, toggleTheme, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Reads the theme.
 *
 * Throws outside a provider rather than returning a default: a component
 * rendered without the provider would silently render hardcoded colours, and
 * that is exactly the class of bug the theme system exists to remove.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside a <ThemeProvider>.');
  }
  return value;
}