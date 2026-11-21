# Mazing Contest

*Build stone mazes. Slow the runner. Outlast rivals.*

**Mazing Contest** is a 3D multiplayer maze-building game inspired by the classic *Warcraft III* custom map, built for desktop browsers and mobile touch screens with **Three.js**, **TypeScript**, **Express**, and **WebSockets (`ws`)**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rayduong/mazing-contest-citadel)

## How It Works

Up to 6 players (humans, bots, or a mix) build on neighboring sunlit islands at the same time. Each round has two phases:

1. **Build Phase:** Place **2×2 Stone Walls** on open grass (with full refunds when removed) to wind the path from the **North Gate** to the **South Shrine**. Nearby walls bridge together automatically, and you can never completely seal the exit.
2. **Run Phase:** A runner enters every island at once. Whoever keeps their runner on the course for the longest time wins the round, with **+2 bonus points (`★ Par`)** for beating the round's Par target.

### Map Structures & Runners

- **Storm Spire:** Pulses every 3.0s, slowing runners by 50% for 2.4s. Best on multi-pass switchbacks.
- **Frost Obelisk:** Chills runners by 22% inside its ring and bursts for a 45% slow every 3.4s. Rewards tight spirals.
- **Chrono Spire:** Slows runners by 55% every 3.8s and cuts 1.2s off every other Spire cooldown.
- **Crimson Keep (`◆` Overcharge):** Connect pre-placed Crimson Keeps into a wall chain that reaches a Spire to **Overcharge** it (`◆` to `◆◆◆`), boosting Spire range, cooldown speed, and armor penetration.
- **Four Runner Types:** Rounds rotate between **Citadel Scouts** (balanced), **Royal Outriders** (fast, longer slow vulnerability), **Iron Juggernauts** (20% slow resist against uncharged Spires), and **Wind Heralds** (+28% speed burst if left un-slowed outside Spires for 3.2s).

## Controls

- **Desktop:** Left-click to place a Stone Wall (`Shift` + drag to paint a line), right-click to remove, drag to pan, scroll wheel to zoom, `Q` Build, `X` Remove, `Z` Undo, `Space` Ready, `Tab` toggle `All Islands` / `My Island`.
- **Mobile Touch:** Tap or drag with the offset loupe reticle to aim a `2×2` Stone Wall, fine-tune 1 tile at a time with the `[← ↑ ↓ →]` precision tray, tap `Place` to build, pinch to zoom, or switch to `Pan` for one-finger camera movement.

## Local Development

Requires **Node.js 18+**.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in one or more browser tabs (or on a phone on your local network).

### Build & Typecheck

```bash
npx tsc --noEmit
npm run build
NODE_ENV=production npm start
```

## Cloud Deployment

Click **Deploy to Render** above (or use [`render.yaml`](./render.yaml)) to run a persistent Node + WebSocket server with health checks at `/api/health` and persistent round records stored in `server/data/leaderboard.json`.
