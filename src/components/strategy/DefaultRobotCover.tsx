/**
 * THE DEFAULT ROBOT COVER
 * =======================
 *
 * A robot without an uploaded cover still has to look like a product, not
 * like a missing image. This is a drawn portrait — a helmet, a visor, a
 * horizon and a circuit board — rendered as inline SVG.
 *
 * WHY SVG AND NOT A GENERATED IMAGE
 *   It costs no network request, it scales to any screen without a second
 *   asset, it never shows a broken image, and it is a few kilobytes instead
 *   of a few hundred. On a cheap Android phone on a slow connection that is
 *   the difference between a card that appears instantly and one that
 *   flickers.
 *
 * WHY IT IS NOT A GRADIENT
 *   A CSS gradient is a background, not artwork. This is drawn: a silhouette
 *   with a lit visor, a horizon, traces and a scanline, with the palette
 *   chosen from the robot's own id so two robots never look identical.
 */

/** A small, stable hash so a robot always gets the same portrait. */
function seedFrom(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

const PALETTES = [
  { glow: '#ff3b47', rim: '#ff7a5c', cool: '#38bdf8', deep: '#14060a' },
  { glow: '#f43f5e', rim: '#fb7185', cool: '#22d3ee', deep: '#12060d' },
  { glow: '#ef4444', rim: '#f59e0b', cool: '#60a5fa', deep: '#150704' },
  { glow: '#dc2626', rim: '#fb923c', cool: '#a78bfa', deep: '#0f0710' },
  { glow: '#e11d48', rim: '#f472b6', cool: '#2dd4bf', deep: '#130510' },
];

export function DefaultRobotCover({ seed, className = '' }: { seed: string; className?: string }) {
  const seedValue = seedFrom(seed || 'robot');
  const palette = PALETTES[seedValue % PALETTES.length];
  const id = `rc${(seedValue % 100000).toString(36)}`;
  const tilt = ((seedValue >> 3) % 9) - 4;
  const ring = 26 + (seedValue % 5) * 3;

  return (
    <svg
      viewBox="0 0 400 500"
      className={className}
      role="img"
      aria-label="Default robot artwork"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.deep} />
          <stop offset="55%" stopColor="#1b0a12" />
          <stop offset="100%" stopColor="#05060c" />
        </linearGradient>
        <radialGradient id={`${id}-halo`} cx="50%" cy="38%" r="52%">
          <stop offset="0%" stopColor={palette.glow} stopOpacity="0.55" />
          <stop offset="55%" stopColor={palette.glow} stopOpacity="0.12" />
          <stop offset="100%" stopColor={palette.glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.cool} stopOpacity="0.95" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.75" />
          <stop offset="100%" stopColor={palette.rim} stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a2f3d" />
          <stop offset="60%" stopColor="#141821" />
          <stop offset="100%" stopColor="#080a10" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.rim} stopOpacity="0.9" />
          <stop offset="100%" stopColor={palette.glow} stopOpacity="0.15" />
        </linearGradient>
      </defs>

      <rect width="400" height="500" fill={`url(#${id}-sky)`} />
      <rect width="400" height="500" fill={`url(#${id}-halo)`} />

      {/* Horizon: the market the robot watches. */}
      <g opacity="0.5">
        <path d={`M0 318 L${200 + tilt} 262 L400 318`} fill="none" stroke={palette.glow} strokeWidth="1.5" opacity="0.55" />
        <path d={`M0 336 L${200 + tilt} 280 L400 336`} fill="none" stroke={palette.glow} strokeWidth="1" opacity="0.3" />
        <path d={`M0 356 L${200 + tilt} 300 L400 356`} fill="none" stroke={palette.glow} strokeWidth="1" opacity="0.16" />
      </g>

      {/* Circuit traces. */}
      <g stroke={palette.cool} strokeWidth="1" fill="none" opacity="0.28">
        <path d="M24 120 H86 V168 H140" />
        <path d="M376 96 H320 V150 H262" />
        <path d="M18 236 H64 V286 H118" />
        <path d="M382 258 H340 V300 H286" />
      </g>
      <g fill={palette.cool} opacity="0.5">
        <circle cx="86" cy="120" r="2.5" />
        <circle cx="320" cy="96" r="2.5" />
        <circle cx="64" cy="236" r="2.5" />
        <circle cx="340" cy="258" r="2.5" />
      </g>

      {/* The halo ring behind the head. */}
      <circle cx="200" cy="178" r={ring + 44} fill="none" stroke={palette.glow} strokeWidth="1" opacity="0.22" />
      <circle cx="200" cy="178" r={ring + 26} fill="none" stroke={palette.glow} strokeWidth="2" opacity="0.35" />

      {/* Shoulders. */}
      <path d="M64 500 C74 398 128 344 200 344 C272 344 326 398 336 500 Z" fill={`url(#${id}-shell)`} />
      <path d="M64 500 C74 398 128 344 200 344 C272 344 326 398 336 500 Z" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="2" opacity="0.75" />

      {/* Neck. */}
      <rect x="174" y="262" width="52" height="72" rx="14" fill="#0d1017" stroke={palette.glow} strokeOpacity="0.4" />

      {/* Head. */}
      <g transform={`rotate(${tilt * 0.6} 200 210)`}>
        <path
          d="M200 96 C256 96 288 134 288 190 C288 246 254 300 200 300 C146 300 112 246 112 190 C112 134 144 96 200 96 Z"
          fill={`url(#${id}-shell)`}
          stroke={`url(#${id}-rim)`}
          strokeWidth="2.5"
        />
        {/* Visor. */}
        <path
          d="M138 176 C138 152 164 140 200 140 C236 140 262 152 262 176 L262 200 C262 218 238 228 200 228 C162 228 138 218 138 200 Z"
          fill="#070a12"
          stroke={palette.cool}
          strokeOpacity="0.5"
        />
        <path
          d="M150 180 C150 162 172 152 200 152 C228 152 250 162 250 180 L250 196 C250 210 230 218 200 218 C170 218 150 210 150 196 Z"
          fill={`url(#${id}-visor)`}
          opacity="0.9"
        />
        {/* The eye line. */}
        <rect x="164" y="182" width="72" height="9" rx="4.5" fill="#0a0d16" opacity="0.85" />
        {/* Crest. */}
        <path d="M200 96 L200 62" stroke={palette.rim} strokeWidth="3" strokeLinecap="round" />
        <circle cx="200" cy="56" r="6" fill={palette.glow} />
        {/* Cheek vents. */}
        <g stroke={palette.glow} strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round">
          <path d="M132 214 H116" />
          <path d="M132 226 H120" />
          <path d="M268 214 H284" />
          <path d="M268 226 H280" />
        </g>
      </g>

      {/* Bottom vignette, so the name and the description always read. */}
      <rect y="330" width="400" height="170" fill="#000" opacity="0.32" />
      <rect y="452" width="400" height="48" fill="#000" opacity="0.35" />
    </svg>
  );
}

export default DefaultRobotCover;
