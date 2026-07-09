# 2048 Versus

Browser-based two-player 2048. Local couch co-op or vs AI. No accounts, no server — pure static files.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173/
npm run build      # output → dist/
npm run preview    # serve dist/ locally
npm run test:engine
```

---

## Architecture

The app is split so **game rules never touch the DOM**, and **AI never runs on the UI thread**.

```
┌─────────────────────────────────────────────────────────┐
│  main.ts          UI shell, input, match orchestration  │
│       │                                                 │
│       ├──── BoardView (ui/)     DOM tiles + CSS anims   │
│       │                                                 │
│       ├──── match.ts / board.ts  pure game engine       │
│       │                                                 │
│       └──── AiClient ──postMessage──► Web Worker        │
│                              │                          │
│                              └─ ai.ts expectimax search │
└─────────────────────────────────────────────────────────┘
```



### Module map


| Path                  | Role                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `src/main.ts`         | App shell: mode/opponent controls, keyboard routing, AI scheduling |
| `src/game/types.ts`   | Shared types (`Direction`, `MatchState`, `MoveResult`, …)          |
| `src/game/rng.ts`     | Seeded Mulberry32 PRNG — same seed ⇒ same spawn sequence           |
| `src/game/board.ts`   | Single-board mechanics: slide, merge, spawn, garbage walls         |
| `src/game/match.ts`   | Two-player match: win/lose, pending garbage, shared seed           |
| `src/game/ai.ts`      | Expectimax + heuristic (DOM-free; safe to import in a worker)      |
| `src/ai/worker.ts`    | Worker entry: receives board snapshot, returns a move              |
| `src/ai/client.ts`    | Main-thread wrapper around the worker (`postMessage` API)          |
| `src/ui/boardView.ts` | One player's board: tile DOM, short CSS transitions                |
| `src/style.css`       | Classic Cirulli-style 2048 palette                                 |




### Data flow for one human move

1. `keydown` → `GameApp.tryMove(player, direction)`
2. `applyPlayerMove` mutates pure state (slide → score → tick garbage → spawn → win check)
3. `BoardView.playMove` animates tile transforms (~100ms); if another key arrives mid-animation, it **snaps** to the latest board instead of stacking transitions
4. Opponent’s “incoming garbage” indicator is refreshed if needed



### Fairness (shared seed)

Both players start from the **same Mulberry32 seed**. Each board has its own RNG instance initialized with that seed, so identical move sequences produce identical boards. Race mode is skill, not luck.

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



## Deployment

This is a **static site**. There is no backend, database, or WebSocket server.

### Build

```bash
npm run build
```

Produces `dist/`:

```
dist/
  index.html
  assets/index-*.js
  assets/index-*.css
  assets/worker-*.js
```

`vite.config.ts` sets `base: "./"` so the app works from a subdirectory or `file://`-style relative hosting.

### Host anywhere that serves static files


| Host                         | Notes                                                |
| ---------------------------- | ---------------------------------------------------- |
| **Cloudflare Pages**         | Connect repo or `wrangler pages deploy dist`         |
| **GitHub Pages**             | Push `dist/` to `gh-pages`, or use Actions           |
| **Netlify**                  | Drag-and-drop `dist/`, or publish directory = `dist` |
| **Any nginx / S3 / itch.io** | Upload `dist/` as the site root                      |


No special headers required beyond normal static hosting. Module workers need a normal `http(s)` origin (not always reliable from `file://`).

### Easiest free deploy (recommended): Netlify Drop

1. Run `npm run build`
2. Open [https://app.netlify.com/drop](https://app.netlify.com/drop)
3. Drag the `dist/` folder onto the page

You get a public HTTPS URL instantly — no account setup required for a quick trial (sign up free to keep / rename the site).

### Also free & easy: Cloudflare Pages

1. Push this repo to GitHub
2. In Cloudflare → Workers & Pages → Create → Connect to Git
3. Build command: `npm run build` · Output directory: `dist`

Or from your machine after `npm run build`:

```bash
npx wrangler pages deploy dist --project-name=2048-versus
```

### GitHub Pages

Push `dist/` (or use Actions to build on every push). Set Pages source to the branch/folder that contains `index.html`.

---



## Design constraints (intentional)

- **No logins / leaderboards** — keep the first version frictionless
- **No React/Vue** — less runtime cost; classic 2048 is DOM + CSS
- **Classic visual language** — warm board, familiar tile colors
- **Logic / AI / render separation** — testable engine, swappable AI backend

