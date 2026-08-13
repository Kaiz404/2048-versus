# 2048 Versus

A competitive twist on the classic 2048: two boards, one race. Play locally on
one keyboard, challenge an AI, or face another player online.

<img width="1646" height="987" alt="2048 Versus gameplay" src="https://github.com/user-attachments/assets/df432b23-649f-4053-83ce-6be593500078" />

**[Overview](#overview) • [How it works](#how-it-works) • [Getting started](#getting-started) • [Deployment](#deployment)**

## Overview

2048 Versus keeps the merging puzzle you know, but puts two boards side by
side and adds a reason to move fast: your opponent is racing you to the same
tile. Both boards are seeded identically, so every game comes down to
decisions, not luck.

Three ways to play:

- **Couch co-op** — one keyboard, split controls (WASD vs. Arrow keys)
- **Vs. AI** — a Web Worker opponent with three difficulty levels
- **Online 1v1** — a 6-character room code pairs two browsers over a
  WebSocket relay

> [!NOTE]
> There are no accounts, logins, or leaderboards. The game is intentionally
> frictionless — open it and play.

## How it works

### Game modes

| Mode | Rules |
|------|-------|
| **Race** | First to the target tile (1024 / 2048 / 4096) wins. If a board locks up, the other player wins once their score is at or above the loser's. |
| **Garbage Duel** | Same win condition as Race, plus combat: merging a large tile queues a "blocker" tile that replaces the opponent's next spawn instead of adding to the board. Bigger merges send **longer-lasting** blockers, not more of them. |

Garbage Duel blocker durations:

| Merge | Blocker lasts |
|-------|----------------|
| 128   | 3 moves |
| 256   | 4 moves |
| 512   | 5 moves |
| 1024  | 6 moves |
| 2048+ | 7 moves |

The number on a blocker tile counts down the moves until it clears.

### Local play

Player 1 moves with **WASD**, Player 2 with **Arrow keys**. **Space** resets
the match at any time.

### The AI opponent

The bot runs an expectimax search in a Web Worker, so it never blocks the
main thread or the board's animations. The worker receives a plain board
snapshot and returns a move — nothing more crosses the thread boundary.

| Difficulty | Search depth | Node budget | Mistake rate | Think delay |
|------------|---------------|-------------|---------------|-------------|
| Easy   | 2 | 1,200  | 8% | 120ms |
| Normal | 3 | 8,000  | 0% | 40ms |
| Hard   | 3 | 12,000 | 0% | 12ms |

Hard keeps Normal's search depth — a full depth-4 search was too heavy for
browsers — and instead pressures you with pace and a larger node budget.

The heuristic weights (monotonicity, empty cells, merge potential, tile sum)
follow the well-known nneonneo-style 2048 solver, ported to be
browser-friendly rather than optimized for maximum tile.

In Vs. AI mode, the bot stays idle until you make your first move, then
plays continuously against you.

### Online multiplayer

Two boards only need to exchange small JSON messages — the direction moved,
the RNG seed, restarts, and pings — so 2048 Versus uses a lightweight
WebSocket relay instead of a peer-to-peer connection like WebRTC. It's
simpler to run and far more reliable across NATs and firewalls than
negotiating a direct connection for this little data.

How a match connects:

1. The host creates a room and gets a 6-character code
2. The guest joins with that code
3. The relay server (`server/relay.mjs`) pairs the two sockets and forwards
   messages between them
4. The host sends the initial game state (`{ hello, seed, mode, target }`)
5. Moves, restarts, and pings then flow through the same socket for the rest
   of the match

### Architecture

```
main.ts          UI shell, input, match orchestration
     │
     ├── BoardView (ui/)       DOM tiles + CSS animations
     │
     ├── match.ts / board.ts   pure game engine
     │
     ├── AiClient ── postMessage ──► Web Worker (expectimax search)
     │
     └── WsRoom (net/) ── WebSocket ──► server/relay.mjs
                            (relays JSON moves between two peers)
```

| Path | Role |
|------|------|
| `src/main.ts` | App shell |
| `src/game/*` | Pure game engine (board, match rules, AI heuristics) |
| `src/net/protocol.ts` | Room codes and game message types |
| `src/net/wsRoom.ts` | Online room client (host/join, ping) |
| `src/ai/*` | Web Worker AI client and worker entry point |
| `server/relay.mjs` | WebSocket room relay |

The engine, AI, and rendering are kept separate on purpose: the engine is
plain, testable TypeScript with no DOM dependency, and the AI backend can be
swapped out (or moved to WebAssembly) without touching game logic or
rendering.

## Getting started

Requires Node.js.

```bash
npm install
npm run dev          # local play or vs. AI — http://localhost:5173/
npm run test:engine   # run the game engine's self-tests
```

To try online multiplayer locally, run the game together with the relay
server:

```bash
npm run dev:online
```

Open two browser tabs (or one normal + one incognito), pick **Opponent:
Online** in both, then **Create Room** in one and **Join** with its code in
the other.

## Deployment

2048 Versus deploys as two independent pieces: a static site for the game,
and a small always-on WebSocket relay for online matches.

### 1. Deploy the relay

The relay (`server/relay.mjs`) needs a host that keeps a process running —
static hosts won't work. A `render.yaml` blueprint is included for
[Render](https://render.com):

1. Push this repo to GitHub
2. On Render, go to **New → Blueprint** and select the repo
   (or **New → Web Service**, with start command `node server/relay.mjs`)
3. Once deployed, open the service URL — you should see `2048 Versus relay OK`
4. Your relay's WebSocket URL is the same host with `wss://` instead of
   `https://`, e.g. `wss://your-service.onrender.com`

> [!NOTE]
> Render's free tier sleeps after idle periods. The first online join after
> a nap can take about 30 seconds while it wakes up.

### 2. Deploy the game

A GitHub Actions workflow (`.github/workflows/deploy.yml`) is already set up
to build and publish to GitHub Pages on every push to `main`/`master`. It
just needs to know where the relay lives:

1. In the GitHub repo, go to **Settings → Secrets and variables → Actions**
2. Add a repository secret named `VITE_RELAY_URL` set to your relay's
   `wss://` URL
3. Push to `main`/`master` (or run the workflow manually)

The build fails fast with a clear error if `VITE_RELAY_URL` is missing or
malformed, so misconfiguration is caught before it ships.

### Configuration reference

| Variable | Used for | Default |
|----------|----------|---------|
| `VITE_RELAY_URL` | Relay URL baked into the production build | `ws://127.0.0.1:8787` (local only) |
| `VITE_DEBUG` | Set to `1` to print relay logs to the browser console | unset |
