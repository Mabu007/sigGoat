/**
 * USER AVATAR
 * ===========
 * The one place a person is drawn, everywhere in the product.
 *
 * THREE RULES
 * -----------
 * 1. IT NEVER SHOWS A BROKEN IMAGE. A url that fails to load falls back to
 *    initials, and a url that is missing falls back to initials. There is no
 *    state in which the browser's torn-image icon reaches a trader.
 *
 * 2. THE FALLBACK IS DETERMINISTIC. The same name always gets the same
 *    initials AND the same colour, so a trader is recognisable across the
 *    room list, the chat and the header. The palette is built from the
 *    app's own accent / positive / info tones rather than random hues, so it
 *    never clashes with the theme.
 *
 * 3. THE ALT TEXT IS A DECISION, NOT A DEFAULT. When the caller renders the
 *    person's name right next to the avatar, the avatar is decorative and
 *    says nothing. Otherwise it says who it is. `decorative` makes that
 *    choice explicit instead of guessing.
 */

import { useEffect, useState } from 'react';

export interface UserAvatarProps {
  /** The person's display name. Drives the initials and the alt text. */
  name?: string | null;
  /** The avatar image url. Falls back to initials when missing or broken. */
  url?: string | null;
  /** The avatar's edge length in pixels. */
  size?: number;
  className?: string;
  /** Overrides the generated initials. */
  initials?: string | null;
  /** True when the name is already rendered nearby, so the avatar is decoration. */
  decorative?: boolean;
}

/**
 * The fallback palettes.
 *
 * Each entry pairs a soft background with the matching readable tone, so the
 * initials stay legible in both themes without a per-theme branch.
 *
 * NOTE: `--color-accent-text` is declared in `@layer base`, not in `@theme`,
 * so Tailwind does not generate a `text-accent-text` utility for it. The
 * arbitrary-value form below is the working spelling of that token.
 */
const PALETTES = [
  'bg-accent-soft text-[color:var(--color-accent-text)]',
  'bg-positive-soft text-positive',
  'bg-info-soft text-info',
] as const;

/** A stable, non-cryptographic hash. The same name always lands on the
 *  same colour, on every device and every reload. */
function hashName(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Two letters from a name: the first two of one word, or the first of two. */
export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';

  const first = Array.from(parts[0]);
  if (parts.length === 1) return first.slice(0, 2).join('').toUpperCase();

  const second = Array.from(parts[1]);
  const head = first[0] ?? '';
  const tail = second[0] ?? '';
  return (head + tail).toUpperCase();
}

export function UserAvatar({
  name,
  url,
  size = 32,
  className,
  initials,
  decorative = false,
}: UserAvatarProps) {
  const [broken, setBroken] = useState(false);

  /**
   * A new url deserves a fresh chance: the previous one may simply have
   * expired, and the replacement might load perfectly well.
   */
  useEffect(() => {
    setBroken(false);
  }, [url]);

  const label = (name ?? '').trim();
  const text = (initials ?? initialsFromName(label)).trim().slice(0, 2).toUpperCase();
  const palette = PALETTES[hashName(label || text || 'trader') % PALETTES.length];
  const showImage = Boolean(url) && !broken;

  const dimension = { width: size, height: size };
  const fontSize = Math.max(10, Math.round(size * 0.38));

  const shared = [
    'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border border-line',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (showImage) {
    return (
      <span className={shared} style={dimension}>
        <img
          src={url as string}
          alt={decorative ? '' : label}
          className="h-full w-full object-cover"
          style={{ width: size, height: size }}
          onError={() => setBroken(true)}
        />
      </span>
    );
  }

  /**
   * The initials fallback.
   *
   * The letters themselves are decoration — a screen reader should hear the
   * name, not "T R". So the initials are hidden from assistive technology
   * and the container carries the accessible name instead.
   */
  return (
    <span
      className={`${shared} ${palette}`}
      style={dimension}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label || 'User'}
      aria-hidden={decorative ? 'true' : undefined}
      title={decorative ? undefined : label || undefined}
    >
      <span
        aria-hidden="true"
        className="font-bold leading-none"
        style={{ fontSize, letterSpacing: '-0.02em' }}
      >
        {text || '·'}
      </span>
    </span>
  );
}

export default UserAvatar;
