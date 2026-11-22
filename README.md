# Mazing Contest

*Build stone mazes. Slow the runner. Outlast rivals.*

**Mazing Contest** is a 3D multiplayer maze-building game inspired by the classic *Warcraft III* custom map, built for desktop browsers and mobile touch screens with **Three.js**, **TypeScript**, **Express**, and **WebSockets (`ws`)**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rayduong/mazing-contest-citadel)

## How It Works

Up to 6 players (humans, bots, or a mix) build side by side on sunlit islands across a 3-, 5-, or 8-round match. Each round has two phases:

1. **Build Phase:** Place **2×2 Stone Walls** on open grass (removing a wall refunds `+1` wall immediately) to wind the runner's path from the **North Gate** to the **South Shrine**, passing through any **Checkpoint Waystones** along the way. Nearby walls connect automatically, and you can never completely block the route.
2. **Run Phase:** A runner enters every island at once. Longer survival times win: keeping your runner on the course longest takes 1st place (`10 pts`), and reaching **`★ Par` (for example `28.0s+`)** earns **`+2` bonus pts**.

### Map Structures & Runners

- **Storm Spire:** Pulses every `3.0s`, slowing runners by `50%` for `2.4s`. Strongest on multi-pass switchbacks.
- **Frost Obelisk:** Chills runners by `22%` inside its ring and bursts for a `45%` slow (`2.2s`) every `3.4s`. Rewards tight spirals.
- **Chrono Spire:** Slows runners by `55%` (`2.0s`) every `3.8s` and cuts `1.2s` off active cooldowns on every other Spire.
- **Crimson Keep (`◆` Overcharge):** Extend a wall chain from a Crimson Keep to reach a Spire (touching or across a 1-tile corridor) to **Overcharge** that Spire (`◆` to `◆◆◆`), increasing its range, cooldown speed, slow strength, slow duration (`+0.25s` per `◆`), and armor penetration.
- **Checkpoint Waystone:** Featured on select rounds (`R3`, `R6`, `R8`). Runners must pass through the gilded waystone before heading to the South Shrine.
- **Four Runner Types:** Rounds rotate between **Citadel Scouts** (`3.5 m/s`, standard slow duration), **Royal Outriders** (`3.85 m/s`, slows last `25%` longer), **Iron Juggernauts** (`3.25 m/s`, resists `20%` of slows unless hit by an Overcharged Spire), and **Wind Heralds** (`3.55 m/s`, gains `+28%` **Tailwind** speed after `3.2s` unslowed outside Spire rings).

## Controls

- **Desktop:** Left-click to place a Stone Wall (`Shift` + drag to paint a wall line), right-click to remove (`Shift` + drag in `Remove` mode to sweep-clear), drag to pan (`Middle-drag` or `Alt` + drag to orbit, scroll wheel to zoom), hover any Spire, Keep, Checkpoint, or Runner to inspect its live stats, `Q` Build, `X` Remove, `Z` Undo (`Ctrl+Shift+Z` / `Ctrl+Y` Redo), `R` Reset to `My Island`, `1–6` Spectate Islands, `Tab` `All Islands` / `My Island`, `Space` Ready.
- **Mobile Touch:** Tap or press-and-drag on the grass to aim a `2×2` Stone Wall ghost above your finger, nudge 1 tile at a time (tap or hold `[← ↑ ↓ →]`), then tap **`Place`** (which automatically steps the ghost `+2` tiles forward for fast wall chains) or re-tap the ghost directly to build. Tap any placed wall to **`Remove (+1)`**, tap any Spire, Keep, Checkpoint, or Runner to inspect it, pinch to zoom, or select **`Pan`** for safe one-finger camera movement.

## Local Development

Requires **Node.js 18+**.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in one or more browser tabs (or on a phone on the same Wi-Fi network).

### Build & Typecheck

```bash
npx tsc --noEmit
npm run build
NODE_ENV=production npm start
```

## Cloud Deployment

Click **Deploy to Render** above (or deploy with [`render.yaml`](./render.yaml)) to run a persistent Node + WebSocket server with health checks at `/api/health` and persistent round records stored in `server/data/leaderboard.json`.
