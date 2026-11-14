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
  | 'herald';

const SVG_PATHS: Record<IconName, string> = {
  // Battlemented Citadel Keep Crest
  hub: `
    <path d="M4 20h16" />
    <path d="M5 20V8h3v2h2V8h4v2h2V8h3v12" />
    <path d="M10 20v-4a2 2 0 0 1 4 0v4" />
  `,
  // Compass / Arena Overview
  compass: `
    <circle cx="12" cy="12" r="8.5" />
    <polygon points="15.5,8.5 13.4,13.4 8.5,15.5 10.6,10.6" />
  `,
  overview: `
    <circle cx="12" cy="12" r="8.5" />
    <polygon points="15.5,8.5 13.4,13.4 8.5,15.5 10.6,10.6" />
  `,
  // Sanctum Focus Reticle
  target: `
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5" />
  `,
  sanctum: `
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5" />
  `,
  // Crenellated 2x2 Turret Pillar
  pillar: `
    <path d="M5 20h14" />
    <path d="M6.5 20v-9.5L5.5 8V5h3v2h2V5h3v2h2V5h3v3l-1 2.5V20" />
    <path d="M9.5 14h5" />
  `,
  // Reclaim / Undo Circular Arrow
  reclaim: `
    <path d="M4.5 9.5h10a4.5 4.5 0 1 1 0 9H9" />
    <path d="M8 6L4.5 9.5 8 13" />
  `,
  // Stopwatch / Clock
  clock: `
    <circle cx="12" cy="12.5" r="8" />
    <path d="M12 8.5v4.2l2.8 1.8" />
    <path d="M10 2.5h4" />
  `,
  // Storm Spire Lightning Bolt
  bolt: `
    <polygon points="13,2.5 5.5,13.5 11.5,13.5 10.5,21.5 18.5,10.5 12.5,10.5" />
  `,
  // Frost Obelisk Crystal / Snowflake
  frost: `
    <path d="M12 2.5v19M4.5 7.5l15 9M19.5 7.5l-15 9" />
    <path d="M10 4.5L12 6.5l2-2M10 19.5l2-2 2 2" />
  `,
  // Chrono Spire Hourglass / Temporal Ring
  chrono: `
    <path d="M6.5 4h11M6.5 20h11" />
    <path d="M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8" />
    <path d="M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8" />
  `,
  // Crimson Keep Fortress Bastion
  keep: `
    <rect x="4.5" y="6" width="15" height="14" rx="1.5" />
    <path d="M4.5 11h15M9.5 6v5M14.5 6v5M12 11v9" />
  `,
  // Clean 5-Point Star
  star: `
    <polygon points="12,3 14.7,8.5 20.8,9.4 16.4,13.7 17.4,19.8 12,16.9 6.6,19.8 7.6,13.7 3.2,9.4 9.3,8.5" />
  `,
  // Solid Gilded Star (Overcharge & Par)
  starFilled: `
    <polygon fill="currentColor" points="12,3 14.7,8.5 20.8,9.4 16.4,13.7 17.4,19.8 12,16.9 6.6,19.8 7.6,13.7 3.2,9.4 9.3,8.5" />
  `,
  // Hall of Fame Trophy Chalice
  trophy: `
    <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
    <path d="M7 6H4.5a2 2 0 0 0 0 4H7M17 6h2.5a2 2 0 0 1 0 4H17" />
    <path d="M12 14v4M8.5 20h7" />
  `,
  // Royal Crown
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
  // Single Architect Profile
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
  // Open Codex / Guide Book
  book: `
    <path d="M3.5 5.5A2.5 2.5 0 0 1 6 3h5.5v16.5H6a2.5 2.5 0 0 0-2.5 2V5.5z" />
    <path d="M20.5 5.5A2.5 2.5 0 0 0 18 3h-5.5v16.5H18a2.5 2.5 0 0 1 2.5 2V5.5z" />
  `,
  // Clean Question / Guide Emblem
  help: `
    <circle cx="12" cy="12" r="8.8" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.8 2.1c-.9.5-1.4 1.1-1.4 2.1" />
    <circle cx="12" cy="17" r="0.6" fill="currentColor" />
  `,
  // Reroll Die
  dice: `
    <rect x="4" y="4" width="16" height="16" rx="3.2" />
    <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
    <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="8.5" cy="15.5" r="1" fill="currentColor" />
    <circle cx="15.5" cy="15.5" r="1" fill="currentColor" />
  `,
  // Auto-Blueprint Wand
  wand: `
    <path d="M4.5 19.5L15 9" />
    <path d="M17.5 3.5v3M16 5h3M19.5 9.5v2M18.5 10.5h2M12.5 4.5v2M11.5 5.5h2" />
    <polygon points="16.5,7.5 18,9 15,12 13.5,10.5" />
  `,
  // Clear Pillars Trash
  trash: `
    <path d="M4.5 7h15" />
    <path d="M9.5 7V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3V7" />
    <path d="M6.8 7l.9 12a1.8 1.8 0 0 0 1.8 1.6h5a1.8 1.8 0 0 0 1.8-1.6l.9-12" />
    <path d="M10.2 11v5.5M13.8 11v5.5" />
  `,
  // More Horizontal Dots (Tools)
  more: `
    <circle cx="6" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="18" cy="12" r="1.4" fill="currentColor" />
  `,
  // Checkmark
  check: `
    <path d="M4.5 12.5l5 5 10-10.5" />
  `,
  // Play Triangle
  play: `
    <polygon fill="currentColor" points="7,4.8 19,12 7,19.2" />
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
  // Open Blueprints Eye
  eye: `
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.6" />
  `,
  // Fog of War Slashed Eye
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
  // Forward Arrow
  arrowRight: `
    <path d="M5 12h14M13 6l6 6-6 6" />
  `,
  // Match Rules Sliders
  sliders: `
    <path d="M4 7h9M17 7h3M15 5v4" />
    <path d="M4 12h3M11 12h9M9 10v4" />
    <path d="M4 17h11M19 17h1M17 15v4" />
  `,
  // Crossed Swords (Play)
  swords: `
    <path d="M14.5 17.5L4 7V4h3l10.5 10.5" />
    <path d="M13 19l6-6M16 16l4 4" />
    <path d="M9.5 17.5L20 7V4h-3L6.5 14.5" />
    <path d="M11 19l-6-6M8 16l-4 4" />
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
  // Runner Archetype: SCOUT (Swift Ranger Blade)
  scout: `
    <path d="M18.5 4.5l-9.8 9.8" />
    <path d="M14.5 4.5h4v4" />
    <path d="M6.5 12.5l5 5M5 19l3.8-3.8" />
  `,
  // Runner Archetype: OUTRIDER (Plumed Swift Crest)
  outrider: `
    <path d="M4.5 17.5h13.5l2-5.5-5 1.5L12 6.5 9 12.5l-4.5-1z" />
    <path d="M4 20h16" />
  `,
  // Runner Archetype: JUGGERNAUT (Heavy Kite Shield)
  juggernaut: `
    <path d="M12 3l7.5 3v5.5c0 4.8-3.2 8.2-7.5 9.8-4.3-1.6-7.5-5-7.5-9.8V6L12 3z" />
    <path d="M12 6.5v11M8.5 10.5h7" />
  `,
  // Runner Archetype: HERALD (Winged Gale Crest)
  herald: `
    <path d="M3.5 12c3.2-4.2 7.5-5.5 12.5-4-2.5 1.8-3.8 3.2-4.5 5 3.5-.8 6.5-.2 9 1.5-3.8 2.8-8.2 3.5-13.5 1.5" />
    <path d="M3.5 16h6" />
  `,
};

export function icon(name: IconName, size = 16, extraClass = ''): string {
  const body = SVG_PATHS[name] || SVG_PATHS.pillar;
  const cls = extraClass ? `svg-icon ${extraClass}` : 'svg-icon';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
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

/**
 * Renders a crisp, gilded tactile SVG medal badge for 1st, 2nd, or 3rd place
 * instead of raw OS medal emojis.
 */
export function getMedalBadge(rank: 1 | 2 | 3, size = 22): string {
  const palette =
    rank === 1
      ? {
          fill: '#f59e0b',
          rim: '#92400e',
          ribbon: '#b45309',
          text: '#ffffff',
        }
      : rank === 2
      ? {
          fill: '#94a3b8',
          rim: '#475569',
          ribbon: '#64748b',
          text: '#ffffff',
        }
      : {
          fill: '#d97706',
          rim: '#78350f',
          ribbon: '#92400e',
          text: '#ffffff',
        };

  return `<svg class="svg-icon medal-svg medal-rank-${rank}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8.5 14.5L6.5 21.5L10.5 19.5L12 21.5V15" fill="${palette.ribbon}" />
    <path d="M15.5 14.5L17.5 21.5L13.5 19.5L12 21.5V15" fill="${palette.ribbon}" />
    <circle cx="12" cy="9.5" r="6.8" fill="${palette.fill}" stroke="${palette.rim}" stroke-width="1.5" />
    <text x="12" y="12.6" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="8.8" font-weight="800" fill="${palette.text}">${rank}</text>
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
