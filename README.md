# 2048 Versus

Browser-based two-player 2048. Local couch co-op, vs AI, or **online 1v1** across browsers/laptops.

<img width="1646" height="987" alt="image" src="https://github.com/user-attachments/assets/df432b23-649f-4053-83ce-6be593500078" />


## Quick start

```bash
npm install
npm run dev          # local / AI play — http://localhost:5173/
npm run dev:online   # game UI + WebSocket relay together
npm run build
npm run test:engine
```

For online testing with two browsers (normal + incognito):

```bash
npm run dev:online
```

Then both tabs → Opponent: **Online** → Create Room / Join with the code.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  main.ts          UI shell, input, match orchestration       │
│       │                                                      │
│       ├──── BoardView (ui/)     DOM tiles + CSS anims        │
│       │                                                      │
│       ├──── match.ts / board.ts  pure game engine            │
│       │                                                      │
│       ├──── AiClient ──postMessage──► Web Worker             │
│       │                                                      │
│       └──── WsRoom (net/) ──WebSocket──► server/relay.mjs    │
│              (relays tiny JSON moves between 2 peers)        │
└──────────────────────────────────────────────────────────────┘
```

| Path | Role |
|------|------|
| `src/main.ts` | App shell |
| `src/game/*` | Pure engine |
| `src/net/protocol.ts` | Room codes + game message types |
| `src/net/wsRoom.ts` | Online room client (host/join, ping) |
| `server/relay.mjs` | Tiny WebSocket room relay |
| `src/ai/*` | Web Worker AI |

---

## Online multiplayer

### What went wrong with WebRTC/PeerJS

Your logs showed the real failure mode:

- Signaling **worked** (host saw `Incoming connection`)
- ICE stuck in `checking` / PC `connecting`
- Data channel **never opened**

That’s common with public PeerJS + browser NAT/ICE (and dead free TURN). For 2048 we only sync tiny move JSON, so a **WebSocket relay is simpler and far more reliable**.

### How it works now

1. Run the relay (`npm run relay` or `npm run dev:online`)
2. Host **Create Room** → 6-character code
3. Guest **Join** with that code
4. Relay pairs the two sockets and forwards game messages
5. Host sends `{ hello, seed, mode, target }`
6. Moves / restarts / ping-pong go through the same socket
7. Ping = RTT of `{ ping }` / `{ pong }`

### Production relay URL

Default relay is `ws://127.0.0.1:8787` (local only).

You now deploy **two things**:

1. **Static game** → GitHub Pages (already wired)
2. **WebSocket relay** → a tiny always-on Node service (`server/relay.mjs`)

#### A. Deploy the relay (free on Render)

1. Push this repo to GitHub (includes `render.yaml`)
2. Go to [Render](https://render.com) → **New** → **Blueprint** → select the repo  
   (or New Web Service → root directory → start command `node server/relay.mjs`)
3. Wait until it’s live, open the service URL (https://….onrender.com) — you should see `2048 Versus relay OK`
4. Your WebSocket URL is the same host with **`wss://`**:
   `wss://YOUR-SERVICE.onrender.com`

> Free Render services sleep after idle. First Online join after a nap can take ~30s while it wakes.

#### B. Point the GitHub Pages build at the relay

1. GitHub repo → **Settings → Secrets and variables → Actions**
2. New secret: `VITE_RELAY_URL` = `wss://YOUR-SERVICE.onrender.com`
3. Push to `main`/`master` (or run the Pages workflow)

The workflow already passes `secrets.VITE_RELAY_URL` into `npm run build`.

#### Local online (no deploy)

```bash
npm run dev:online
```

---



## How the AI runs

```
Main thread                         Worker thread
───────────                         ─────────────
scheduleAi()
  └─ delay (Easy 160ms / …)
       └─ AiClient.request(cells, difficulty)
            postMessage({ cells, difficulty })
                                         chooseAiMove()
                                           expectimax search
            ◄── postMessage({ move })
       tryMove(1, move)
       scheduleAi()   // keep racing
```



### Why a Web Worker?

Expectimax expands many chance nodes. Running it on the main thread would hitch animations and input. The worker receives a plain `number[]` board snapshot and returns a direction (`0=UP … 3=LEFT`). The UI stays at 60fps.

### Difficulty knobs (`src/game/ai.ts`)


| Level  | Search depth | Node budget | Mistake rate | Think delay |
| ------ | ------------ | ----------- | ------------ | ----------- |
| Easy   | 2            | 1200        | 8%           | 120ms       |
| Normal | 3            | 8000        | 0%           | 40ms        |
| Hard   | 3            | 12000       | 0%           | 12ms        |

Hard keeps Normal’s search depth (depth-4 was too heavy for browsers) and pressures you with pace + a larger node budget instead.

In vs AI, the bot stays idle until you make your **first move**. **Space** always resets the match.

Heuristic weights follow the nneonneo / project Python solver (monotonicity, empties, merges, tile-sum). This is a **browser-friendly** port — not the C-accelerated “16k tile” search. Stronger play later can compile that C core to WebAssembly and keep the same worker boundary.

### AI pacing

In vs-AI mode the bot stays idle until your **first move**, then races continuously. **Space** always resets. Starting a new game bumps `aiGeneration` so in-flight worker replies are ignored.

---



## Game modes

**Race** — first to the target tile (1024 / 2048 / 4096). If a board locks, the other player wins when their score is ≥ the loser’s (or immediately if already ahead).

**Garbage Duel** — same win rules, plus combat. Bigger merges send a **longer-lasting** blocker (not more blockers):

| Merge | Blocker duration |
| ----- | ---------------- |
| 128   | 3 moves          |
| 256   | 4 moves          |
| 512   | 5 moves          |
| 1024  | 6 moves          |
| 2048+ | 7 moves          |

Queued garbage **replaces the opponent’s next 2/4 spawn** — it never overwrites existing tiles. The digit on a blocker is moves remaining.

---



## Performance notes

- Animations use only `transform` / `opacity` (compositor-friendly)
- Animation duration is short (~100ms); rapid input skips mid-flight animation
- Engine is allocation-light on the hot path; AI caps chance-node branching
- Production bundle is ~17KB JS + ~3KB worker + ~5KB CSS (pre-gzip)

---



## Design constraints (intentional)

- **No logins / leaderboards** — keep the first version frictionless
- **No React/Vue** — less runtime cost; classic 2048 is DOM + CSS
- **Classic visual language** — warm board, familiar tile colors
- **Logic / AI / render separation** — testable engine, swappable AI backend

