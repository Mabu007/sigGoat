/**
 * THEME TOGGLE
 * ============
 * A single icon button in the header that switches between the two designed
 * themes.
 *
 * BOTH ICONS ARE ALWAYS MOUNTED and cross-faded, rather than the icon being
 * swapped on state change. Swapping causes a one-frame pop as the glyph
 * changes; cross-fading reads as a transition and costs nothing.
 *
 * Accessibility: the button carries an explicit `aria-label` that names the
 * ACTION ("Switch to dark theme"), not the current state — a screen reader
 * user needs to know what pressing it will do. `aria-pressed` carries the
 * state itself.
 */

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-pressed={isDark}
      title={isDark ? 'Light theme' : 'Dark theme'}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted transition-colors hover:bg-raised hover:text-fg ${className}`}
    >
      <Sun
        size={16}
        aria-hidden="true"
        className={`absolute transition-all duration-200 ${
          isDark ? 'scale-50 rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
        }`}
      />
      <Moon
        size={16}
        aria-hidden="true"
        className={`absolute transition-all duration-200 ${
          isDark ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
        }`}
      />
    </button>
  );
}