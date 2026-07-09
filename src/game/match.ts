import {
  canMove,
  emptyBoard,
  emptyIds,
  emptyTtl,
  executeMove,
  maxTile,
  movesAvailable,
  resetTileIds,
  spawnRandom,
  spawnTile,
  tickGarbage,
} from "./board";
import { mulberry32, randomSeed, type Rng } from "./rng";
import type {
  Direction,
  MatchConfig,
  MatchState,
  MoveResult,
  PlayerId,
  PlayerState,
} from "./types";

export interface PlayerRuntime {
  state: PlayerState;
  rng: Rng;
}

export interface MatchRuntime {
  state: MatchState;
  players: [PlayerRuntime, PlayerRuntime];
}

function createPlayer(rng: Rng): PlayerRuntime {
  const cells = emptyBoard();
  const ids = emptyIds();
  const garbageTtl = emptyTtl();
  spawnRandom(cells, ids, rng);
  spawnRandom(cells, ids, rng);
  return {
    rng,
    state: {
      cells,
      ids,
      garbageTtl,
      score: 0,
      highest: maxTile(cells),
      alive: true,
      won: false,
    },
  };
}

export function createMatch(config: MatchConfig): MatchRuntime {
  resetTileIds(1);
  const seed = config.seed ?? randomSeed();
  // Identical seeds ⇒ identical spawn sequences for fair races.
  const p0 = createPlayer(mulberry32(seed));
  const p1 = createPlayer(mulberry32(seed));

  const state: MatchState = {
    config: { ...config, seed },
    seed,
    players: [p0.state, p1.state],
    status: "playing",
    winner: null,
    pendingGarbage: [[], []],
    message: "",
  };

  return { state, players: [p0, p1] };
}

function opponentOf(id: PlayerId): PlayerId {
  return id === 0 ? 1 : 0;
}

function finish(state: MatchState, winner: PlayerId | "draw", message: string): void {
  state.status = "finished";
  state.winner = winner;
  state.message = message;
}

function evaluateAfterMove(match: MatchRuntime, mover: PlayerId): void {
  const { state } = match;
  const { config } = state;
  const me = state.players[mover];
  const opp = state.players[opponentOf(mover)];

  if (me.highest >= config.target) {
    me.won = true;
    finish(state, mover, `Player ${mover + 1} reached ${config.target}!`);
    return;
  }

  if (!me.alive && !opp.alive) {
    if (me.score === opp.score) {
      finish(state, "draw", "Both boards locked — draw!");
    } else {
      const winner: PlayerId = me.score > opp.score ? mover : opponentOf(mover);
      finish(state, winner, "Both boards locked — higher score wins!");
    }
    return;
  }

  if (!me.alive && opp.alive) {
    if (opp.score >= me.score) {
      finish(state, opponentOf(mover), `Player ${mover + 1} is out!`);
    } else {
      state.message = `Player ${mover + 1} is out — Player ${opponentOf(mover) + 1} must beat ${me.score}!`;
    }
    return;
  }

  if (!opp.alive && me.alive && me.score >= opp.score) {
    finish(state, mover, `Player ${mover + 1} secured the win!`);
  }
}

/**
 * Apply one legal move for a player. Returns null if ignored (dead / finished / no-op).
 *
 * Garbage mode: pending attacks replace the post-move 2/4 spawn with a blocker.
 * Existing tiles are never overwritten.
 */
export function applyPlayerMove(
  match: MatchRuntime,
  player: PlayerId,
  dir: Direction,
): MoveResult | null {
  const { state } = match;
  if (state.status !== "playing") return null;

  const runtime = match.players[player];
  const ps = runtime.state;
  if (!ps.alive) return null;

  const move = executeMove(ps.cells, ps.ids, ps.garbageTtl, dir);
  if (!move.moved) return null;

  ps.score += move.scoreGained;
  if (move.maxMerge > ps.highest) ps.highest = move.maxMerge;
  const boardMax = maxTile(ps.cells);
  if (boardMax > ps.highest) ps.highest = boardMax;

  // Countdown existing blockers after the slide.
  tickGarbage(ps.cells, ps.ids, ps.garbageTtl);

  // Spawn: consume one pending garbage TTL if any, else a normal 2/4.
  let spawnGarbageTtl: number | undefined;
  if (state.config.mode === "garbage" && state.pendingGarbage[player].length > 0) {
    spawnGarbageTtl = state.pendingGarbage[player].shift();
  }
  const spawn = spawnTile(ps.cells, ps.ids, ps.garbageTtl, runtime.rng, spawnGarbageTtl);

  if (state.config.mode === "garbage" && move.garbageTtlsSent.length > 0) {
    const opp = opponentOf(player);
    state.pendingGarbage[opp].push(...move.garbageTtlsSent);
  }

  if (!movesAvailable(ps.cells)) {
    ps.alive = false;
  }

  evaluateAfterMove(match, player);

  return {
    ...move,
    spawn,
  };
}

export function legalDirections(cells: number[]): Direction[] {
  const dirs: Direction[] = [0, 1, 2, 3];
  return dirs.filter((d) => canMove(cells, d));
}

/** Snapshot cells for the AI worker (plain array, garbage as -1). */
export function boardSnapshot(ps: PlayerState): number[] {
  return ps.cells.slice();
}

export function playerLabel(id: PlayerId, opponent: MatchConfig["opponent"]): string {
  if (opponent === "ai") {
    return id === 0 ? "You" : "AI";
  }
  return id === 0 ? "Player 1 (WASD)" : "Player 2 (Arrows)";
}

/** How many garbage spawns are queued for a player (for the banner). */
export function pendingGarbageCount(state: MatchState, player: PlayerId): number {
  return state.pendingGarbage[player].length;
}
