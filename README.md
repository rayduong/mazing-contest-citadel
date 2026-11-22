# Mazing Contest

*Build stone mazes. Slow the runner. Outlast rivals.*

**Mazing Contest** is a 3D multiplayer maze-building game inspired by the classic *Warcraft III* custom map, built for desktop browsers and mobile touch screens with **Three.js**, **TypeScript**, **Express**, and **WebSockets (`ws`)**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rayduong/mazing-contest-citadel)

## How It Works

Up to 6 players (humans, bots, or a mix) build side by side on sunlit islands across a 3-, 5-, or 8-round match. Each round has two phases:

1. **Build Phase:** Place **2×2 Stone Walls** on open grass (removing a wall refunds `+1` wall immediately) to wind the runner's path from the **North Gate** to the **South Shrine**, passing through any gilded **Waystones** along the way. Nearby walls connect automatically, and you can never completely block the route.
2. **Run Phase:** A runner enters every island at once. Longer survival times win (`10 / 7 / 5 / 3 / 2 / 1 pts` by rank), and keeping your runner on the course past **`★ Par` (such as `28.0s+`)** earns **`+2` bonus pts**.

### Map Structures & Runners

- **Storm Spire:** Pulses every `3.0s` (`3.45m` ring), slowing runners by `50%` for `2.4s`. Strongest on multi-pass switchbacks.
- **Frost Obelisk:** Chills runners by `22%` inside its `3.3m` ring and bursts for a `45%` slow (`2.2s`) every `3.4s`. Rewards tight spirals.
- **Chrono Spire:** Pulses every `3.8s` (`3.65m` ring), slowing runners by `55%` (`2.0s`) and shaving `1.2s` off other Spires' cooldowns (or pre-charging ready Spires toward their next pulse).
- **Crimson Keep (`◆` Overcharge):** Connect red Crimson Keeps through touching walls to within `1` corridor tile of a Spire to **Overcharge** it (`◆` to `◆◆◆`), boosting Spire range, recharge speed, slow strength, slow duration (`+0.25s` per `◆`), and piercing Juggernaut armor.
- **Waystone:** Featured on Rounds `3`, `6`, and `8`. Runners pass through this walkable gilded arch before heading to the South Shrine.
- **Four Runner Types:** Rounds rotate between **Citadel Scouts** (`3.5 m/s`, balanced runner, full slow effect), **Royal Outriders** (`3.85 m/s`, fast sprinter, slows last `25%` longer), **Iron Juggernauts** (`3.25 m/s`, resists `20%` of slows unless hit by an Overcharged Spire), and **Wind Heralds** (`3.55 m/s`, gains `+28%` **Tailwind** speed after `3.2s` unslowed outside Spires).

## Controls & Practice

- **Desktop:** Left-click to place a Stone Wall (`Shift` + drag to line-paint across your full wall supply), right-click to remove (`Shift` + drag in `Remove` mode to sweep-clear), drag to pan (`Middle-drag` or `Alt` + drag to orbit, scroll wheel to zoom), hover any Spire, Keep, Waystone, Gate, or Runner to inspect its live stats, `Q` Build, `X` Remove, `Z` Undo, `Redo` button (`Ctrl+Y` / `Ctrl+Shift+Z`), `R` Reset View to `My Island`, `1–6` Spectate Islands, `Tab` `All Islands` / `My Island`, `Space` Ready.
- **Mobile Touch:** Tap grass or hold-and-drag to aim a `2×2` Stone Wall ghost above your finger, nudge `1` tile at a time (tap or hold `[← ↑ ↓ →]`, stepping `+2` tiles cleanly across existing walls), then tap **`Place`** (`+2`-tile chain-advance) or re-tap the ghost directly to build. Tap any placed wall to **`Remove (+1)`**, tap any Spire, Keep, Waystone, Gate, or Runner to inspect it, pinch to zoom, or select **`Pan`** for one-finger camera movement.
- **Practice & Custom Rooms:** Open **`Tools → Sample Maze · Practice`** to study a starter maze on any round (runs using Sample Maze stay unranked on the Leaderboard), or customize rounds (`3 / 5 / 8`), build timer, wall supply (`80% / Normal / 125%`), bots (`0–5`), bot skill, and rival maze visibility (`Hide Mazes`).

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
