import { RunnerArchetype, SpireType } from '../shared/types.js';

export type IconName =
  | 'hub'
  | 'compass'
  | 'overview'
  | 'target'
  | 'sanctum'
  | 'pillar'
  | 'reclaim'
  | 'clock'
  | 'bolt'
  | 'frost'
  | 'chrono'
  | 'keep'
  | 'star'
  | 'starFilled'
  | 'trophy'
  | 'crown'
  | 'users'
  | 'user'
  | 'volumeOn'
  | 'volumeOff'
  | 'book'
  | 'help'
  | 'dice'
  | 'wand'
  | 'trash'
  | 'more'
  | 'check'
  | 'play'
  | 'refresh'
  | 'link'
  | 'globe'
  | 'lock'
  | 'eye'
  | 'eyeOff'
  | 'close'
  | 'chevronDown'
  | 'arrowRight'
  | 'sliders'
  | 'swords'
  | 'flag'
  | 'plus'
  | 'minus'
  | 'send'
  | 'scout'
  | 'outrider'
  | 'juggernaut'
  | 'herald'
  | 'undo'
  | 'redo'
  | 'pan'
  | 'arrowLeft'
  | 'arrowUp'
  | 'arrowDown'
  | 'diamond'
  | 'diamondFilled'
  | 'share'
  | 'calendar'
  | 'copy'
  | 'logout';

const SVG_PATHS: Record<IconName, string> = {
  // Battlemented Citadel Keep Crest (3.2-unit embrasures prevent stroke fusion at 16-18px)
  hub: `
    <path d="M3 20h18" />
    <path d="M4.2 20V7.5h3.2v2.8h3.2V7.5h2.8v2.8h3.2V7.5h3.2V20" />
    <path d="M10 20v-4a2 2 0 0 1 4 0v4" />
  `,
  // Navigation Compass
  compass: `
    <circle cx="12" cy="12" r="8.5" />
    <polygon points="15.5,8.5 13.4,13.4 8.5,15.5 10.6,10.6" />
  `,
  // All Islands Overview (2x2 Island Grid — distinct from compass)
  overview: `
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
  `,
  // Reset Camera Focus Reticle
  target: `
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5" />
  `,
  // My Island Plateau & Shrine (distinct from sniper reticle)
  sanctum: `
    <path d="M8.5 15V8.5L12 5l3.5 3.5V15" />
    <path d="M3.5 15.5L12 19.5l8.5-4" />
    <path d="M6.8 18.8L12 21.2l5.2-2.4" />
  `,
  // Buildable 2x2 Stone Wall Turret (wide open embrasure for 12-18px clarity)
  pillar: `
    <path d="M4.5 20h15" />
    <path d="M6.5 20v-9L5.5 8.5V5h4.5v2.5h4V5h4.5v3.5L17.5 11v9" />
    <path d="M6.5 11h11" />
  `,
  // Remove 2x2 Stone Wall Reticle (distinct from Undo curved arrow)
  reclaim: `
    <path d="M4.5 8.5V5.5a1 1 0 0 1 1-1h3" />
    <path d="M15.5 4.5h3a1 1 0 0 1 1 1v3" />
    <path d="M19.5 15.5v3a1 1 0 0 1-1 1h-3" />
    <path d="M8.5 19.5h-3a1 1 0 0 1-1-1v-3" />
    <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
  `,
  // Stopwatch / Run Time
  clock: `
    <circle cx="12" cy="12.5" r="8" />
    <path d="M12 8.5v4.2l2.8 1.8" />
    <path d="M10 2.5h4" />
  `,
  // Storm Spire Lightning Bolt
  bolt: `
    <polygon points="13,2.5 5.5,13.5 11.5,13.5 10.5,21.5 18.5,10.5 12.5,10.5" />
  `,
  // Frost Obelisk Crystal
  frost: `
    <path d="M12 2.5v19M4.5 7.5l15 9M19.5 7.5l-15 9" />
    <path d="M10 4.5L12 6.5l2-2M10 19.5l2-2 2 2" />
  `,
  // Chrono Spire Hourglass
  chrono: `
    <path d="M6.5 4h11M6.5 20h11" />
    <path d="M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8" />
    <path d="M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8" />
  `,
  // Crimson Keep Bastion with Pitched Roof & Crown Brazier (matches 3D Keep)
  keep: `
    <polygon fill="currentColor" stroke="none" points="12,1.8 14.3,4.3 12,6.8 9.7,4.3" />
    <path d="M4.8 12L12 7.8 19.2 12" />
    <path d="M6.5 11.2V20h11v-8.8" />
    <path d="M4.5 20h15" />
    <path d="M12 12.5v4" />
  `,
  // Clean 5-Point Star (Round Par outline)
  star: `
    <polygon points="12,3 14.7,8.5 20.8,9.4 16.4,13.7 17.4,19.8 12,16.9 6.6,19.8 7.6,13.7 3.2,9.4 9.3,8.5" />
  `,
  // Solid Gilded Star (Round Par bonus — stroke="none" prevents 10-11px point bloat)
  starFilled: `
    <polygon fill="currentColor" stroke="none" points="12,2.6 14.4,8.9 21.1,9.2 15.9,13.5 17.6,20 12,16.3 6.4,20 8.1,13.5 2.9,9.2 9.6,8.9" />
  `,
  // Leaderboard Trophy Chalice
  trophy: `
    <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
    <path d="M7 6H4.5a2 2 0 0 0 0 4H7M17 6h2.5a2 2 0 0 1 0 4H17" />
    <path d="M12 14v4M8.5 20h7" />
  `,
  // Champion Crown
  crown: `
    <path d="M3.5 18.5h17L19 7.5l-4.2 3.8L12 5.5 9.2 11.3 5 7.5 3.5 18.5z" />
  `,
  // Players / Room & Chat
  users: `
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="16.5" cy="9.5" r="2.5" />
    <path d="M15.5 19a4.5 4.5 0 0 1 5 0" />
  `,
  // Single Player Profile
  user: `
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  `,
  // Audio On
  volumeOn: `
    <polygon points="4.5,9.5 8.5,9.5 13.5,5.5 13.5,18.5 8.5,14.5 4.5,14.5" />
    <path d="M16.8 8.8a4.5 4.5 0 0 1 0 6.4" />
    <path d="M19.3 6.3a8 8 0 0 1 0 11.4" />
  `,
  // Audio Muted
  volumeOff: `
    <polygon points="4.5,9.5 8.5,9.5 13.5,5.5 13.5,18.5 8.5,14.5 4.5,14.5" />
    <path d="M17 9.5l4.5 5M21.5 9.5l-4.5 5" />
  `,
  // Open Guide Book (single shared center spine prevents 15px double-stroke blotch)
  book: `
    <path d="M3 5.5C5.5 4.3 9 4.5 12 6c3-1.5 6.5-1.7 9-.5v13.5c-2.5-1.2-6-1-9 .5-3-1.5-6.5-1.7-9-.5V5.5z" />
    <path d="M12 6v13.5" />
  `,
  // Guide Question Emblem
  help: `
    <circle cx="12" cy="12" r="8.8" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.8 2.1c-.9.5-1.4 1.1-1.4 2.1" />
    <circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none" />
  `,
  // New Map Seed Die
  dice: `
    <rect x="4" y="4" width="16" height="16" rx="3.2" />
    <circle cx="8.5" cy="8.5" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.05" fill="currentColor" stroke="none" />
  `,
  // Sample Maze Wand
  wand: `
    <path d="M4.5 19.5L15 9" />
    <path d="M17.5 3.5v3M16 5h3M19.5 9.5v2M18.5 10.5h2M12.5 4.5v2M11.5 5.5h2" />
    <polygon points="16.5,7.5 18,9 15,12 13.5,10.5" />
  `,
  // Clear All Trash
  trash: `
    <path d="M4.5 7h15" />
    <path d="M9.5 7V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3V7" />
    <path d="M6.8 7l.9 12a1.8 1.8 0 0 0 1.8 1.6h5a1.8 1.8 0 0 0 1.8-1.6l.9-12" />
    <path d="M10.2 11v5.5M13.8 11v5.5" />
  `,
  // More Horizontal Dots (Tools)
  more: `
    <circle cx="6" cy="12" r="1.45" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.45" fill="currentColor" stroke="none" />
  `,
  // Checkmark
  check: `
    <path d="M4.5 12.5l5 5 10-10.5" />
  `,
  // Play Triangle (stroke="none" & optically centered at cx = 12)
  play: `
    <polygon fill="currentColor" stroke="none" points="8,4.6 20,12 8,19.4" />
  `,
  // Refresh / Restart
  refresh: `
    <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
    <path d="M20 20v-4h-4" />
  `,
  // Invite Chain Link
  link: `
    <path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.5 1.5" />
    <path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.5-1.5" />
  `,
  // Public Globe
  globe: `
    <circle cx="12" cy="12" r="8.8" />
    <path d="M3.5 12h17" />
    <path d="M12 3.2c2.6 2.5 4 5.6 4 8.8s-1.4 6.3-4 8.8c-2.6-2.5-4-5.6-4-8.8s1.4-6.3 4-8.8z" />
  `,
  // Private Lock
  lock: `
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  `,
  // Visible Rival Mazes Eye
  eye: `
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.6" />
  `,
  // Hidden Rival Mazes Slashed Eye
  eyeOff: `
    <path d="M3.5 3.5l17 17" />
    <path d="M9.9 6.3A9.4 9.4 0 0 1 12 6c6 0 9.5 6 9.5 6a16.5 16.5 0 0 1-3.4 4.2" />
    <path d="M6.3 8.1A16.2 16.2 0 0 0 2.5 12S6 18 12 18c1.5 0 2.9-.4 4.1-1" />
  `,
  // Close Cross
  close: `
    <path d="M6 6l12 12M18 6L6 18" />
  `,
  // Chevron Down
  chevronDown: `
    <path d="M6.5 9.5L12 15l5.5-5.5" />
  `,
  // East (+X) Nudge / Forward Arrow
  arrowRight: `
    <path d="M5 12h14M13 6l6 6-6 6" />
  `,
  // Room Rules Sliders
  sliders: `
    <path d="M4 7h9M17 7h3M15 5v4" />
    <path d="M4 12h3M11 12h9M9 10v4" />
    <path d="M4 17h11M19 17h1M17 15v4" />
  `,
  // Crossed Swords (Play — broken back-blade gap prevents center knot at 14-16px)
  swords: `
    <path d="M4.5 4.5l15 15" />
    <path d="M13.5 17.5l4-4" />
    <path d="M19.5 4.5L14.2 9.8M9.8 14.2L4.5 19.5" />
    <path d="M6.5 13.5l4 4" />
  `,
  // Finish Flag
  flag: `
    <path d="M5 21V4" />
    <path d="M5 4.5h12.5l-2.5 4.2 2.5 4.3H5" />
  `,
  // Plus
  plus: `
    <path d="M12 5v14M5 12h14" />
  `,
  // Minus
  minus: `
    <path d="M5 12h14" />
  `,
  // Send Arrow
  send: `
    <path d="M20.5 3.5L10 14" />
    <polygon points="20.5,3.5 13.8,20.5 10,14 3.5,10.2" />
  `,
  // Runner Archetype: SCOUT (Wayfarer Crook Staff & Glowing Diamond Lantern — matches 3D Scout)
  scout: `
    <path d="M7 20.5V7.5a3.5 3.5 0 0 1 7 0V9" />
    <polygon points="14,10.2 17.2,14 14,17.8 10.8,14" />
    <circle cx="14" cy="14" r="1" fill="currentColor" stroke="none" />
  `,
  // Runner Archetype: OUTRIDER (Couched Cavalry Spear & Swallowtail Pennant — matches 3D Outrider)
  outrider: `
    <path d="M4.5 19.5l15-15" />
    <path d="M15 4.5h4.5V9" />
    <path d="M15.5 8.5l-9-2 2.5 3.5-2.5 3.5 5-1" />
  `,
  // Runner Archetype: JUGGERNAUT (Heavy Heater Shield — matches 3D Juggernaut)
  juggernaut: `
    <path d="M12 3l7.5 3v5.5c0 4.8-3.2 8.2-7.5 9.8-4.3-1.6-7.5-5-7.5-9.8V6L12 3z" />
    <path d="M12 6.5v11M8.5 10.5h7" />
  `,
  // Runner Archetype: HERALD (Crisp Twin Gale Curls — readable at 12-14px)
  herald: `
    <path d="M3.5 9.5h10.8a2.7 2.7 0 1 0-2.7-2.7" />
    <path d="M3.5 13.5h14a2.8 2.8 0 1 1-2.8 2.8" />
    <path d="M5.5 17.5h5" />
  `,
  // Counter-Clockwise Undo Arrow (Z / Ctrl+Z)
  undo: `
    <path d="M4.5 9.5h10a4.5 4.5 0 1 1 0 9H9" />
    <path d="M8.5 5.5l-4 4 4 4" />
  `,
  // Clockwise Redo Arrow (Ctrl+Shift+Z / Ctrl+Y)
  redo: `
    <path d="M19.5 9.5h-10a4.5 4.5 0 1 0 0 9H15" />
    <path d="M15.5 5.5l4 4-4 4" />
  `,
  // 4-Direction Camera Pan Cross
  pan: `
    <path d="M12 3v18M3 12h18" />
    <path d="M9.5 5.5L12 3l2.5 2.5" />
    <path d="M9.5 18.5L12 21l2.5-2.5" />
    <path d="M5.5 9.5L3 12l2.5 2.5" />
    <path d="M18.5 9.5L21 12l-2.5 2.5" />
  `,
  // West (-X) Nudge / Back Arrow
  arrowLeft: `
    <path d="M19 12H5M11 6l-6 6 6 6" />
  `,
  // North (-Y) Nudge Arrow
  arrowUp: `
    <path d="M12 19V5M6 11l6-6 6 6" />
  `,
  // South (+Y) Nudge Arrow
  arrowDown: `
    <path d="M12 5v14M6 13l6 6 6-6" />
  `,
  // Symmetric Outline Overcharge Pip (◇)
  diamond: `
    <polygon points="12,3.5 20.5,12 12,20.5 3.5,12" />
  `,
  // Symmetric Solid Overcharge Pip (◆ — stroke="none" keeps sharp 90° facets at 10-11px)
  diamondFilled: `
    <polygon fill="currentColor" stroke="none" points="12,2.8 21.2,12 12,21.2 2.8,12" />
  `,
  // Mobile Native Share Sheet Icon
  share: `
    <path d="M12 3.5v11" />
    <path d="M8 7.5l4-4 4 4" />
    <path d="M5 13.5v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  `,
  // Daily Maze Calendar Icon
  calendar: `
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M8 2.8v4.2M16 2.8v4.2M3.5 10h17" />
    <path d="M9.5 14.5l1.7 1.7 3.5-3.5" />
  `,
  // Copy Code Icon
  copy: `
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  `,
  // Leave Room / Lobby Icon
  logout: `
    <path d="M10 4.5H5.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" />
    <path d="M15 16l4.5-4L15 8M19.5 12H9" />
  `,
};

/**
 * Renders an inline SVG icon with size-adaptive optical stroke weight so
 * 11-13px micro-badges stay razor-sharp while 20-24px emblems stay refined.
 */
export function icon(name: IconName, size = 16, extraClass = ''): string {
  const body = SVG_PATHS[name] || SVG_PATHS.pillar;
  const cls = extraClass ? `svg-icon ${extraClass}` : 'svg-icon';
  const strokeWidth =
    size <= 13 ? '2.15' : size <= 16 ? '1.95' : size <= 19 ? '1.8' : '1.7';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function getRunnerIcon(
  runnerType: RunnerArchetype = 'SCOUT',
  size = 14
): string {
  switch (runnerType) {
    case 'OUTRIDER':
      return icon('outrider', size, 'runner-arch-icon');
    case 'JUGGERNAUT':
      return icon('juggernaut', size, 'runner-arch-icon');
    case 'HERALD':
      return icon('herald', size, 'runner-arch-icon');
    case 'SCOUT':
    default:
      return icon('scout', size, 'runner-arch-icon');
  }
}

export function getSpireIcon(spireType: SpireType, size = 14): string {
  switch (spireType) {
    case 'FROST_OBELISK':
      return icon('frost', size);
    case 'CHRONO_SPIRE':
      return icon('chrono', size);
    case 'THUNDERCLAP':
    default:
      return icon('bolt', size);
  }
}

const MEDAL_RANK_PATHS: Record<1 | 2 | 3, string> = {
  1: `<path d="M10.7 7.8L12.1 6.7v5.6M10.6 12.3h3" />`,
  2: `<path d="M10.2 8.1a1.85 1.6 0 0 1 3.65 0.3c0 1.05-.9 1.8-3.65 3.9h3.75" />`,
  3: `<path d="M10.35 7.35c.42-.48 1.02-.72 1.75-.72 1.05 0 1.75.54 1.75 1.32 0 .78-.68 1.38-1.95 1.48 1.32.1 2.05.68 2.05 1.52 0 .92-.8 1.52-1.95 1.52-.8 0-1.45-.26-1.85-.75" />`,
};

/**
 * Renders a high-contrast gilded tactile SVG medal badge for 1st, 2nd, or 3rd place
 * using platform-invariant geometric vector <path> numerals (WCAG AAA contrast, zero <text> font drift,
 * split swallowtail ribbons, and single-stroke waist geometry).
 */
export function getMedalBadge(rank: 1 | 2 | 3, size = 22): string {
  const palette =
    rank === 1
      ? {
          fill: '#fbbf24',
          rim: '#b45309',
          ribbon: '#d97706',
          numeral: '#451a03',
        }
      : rank === 2
      ? {
          fill: '#e2e8f0',
          rim: '#475569',
          ribbon: '#64748b',
          numeral: '#1e293b',
        }
      : {
          fill: '#f0a35e',
          rim: '#9a3412',
          ribbon: '#b45309',
          numeral: '#431407',
        };

  return `<svg class="svg-icon medal-svg medal-rank-${rank}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.2 14.6L6.4 21.4l2.7-1.5 2.15 1.9V15.2" fill="${palette.ribbon}" />
    <path d="M15.8 14.6l1.8 6.8-2.7-1.5-2.15 1.9V15.2" fill="${palette.ribbon}" />
    <circle cx="12" cy="9.5" r="6.8" fill="${palette.fill}" stroke="${palette.rim}" stroke-width="1.5" />
    <circle cx="12" cy="9.5" r="5.3" stroke="rgba(255,255,255,0.48)" stroke-width="0.7" />
    <g stroke="${palette.numeral}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${MEDAL_RANK_PATHS[rank]}</g>
  </svg>`;
}

/**
 * Hydrates any <span data-icon="name" data-icon-size="16"> placeholders in static HTML.
 */
export function hydrateStaticIcons(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-icon]');
  nodes.forEach((el) => {
    const name = el.dataset.icon as IconName;
    const size = Number(el.dataset.iconSize || 16);
    if (name && SVG_PATHS[name]) {
      el.innerHTML = icon(name, size);
    }
  });
}
