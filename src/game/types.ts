/** Direction indices match classic 2048 / expectimax convention. */
export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;

export type Direction = typeof UP | typeof RIGHT | typeof DOWN | typeof LEFT;

export const SIZE = 4;
export const CELLS = 16;

/** Occupied blocker that cannot merge; clears after a few of the owner's moves. */
export const GARBAGE = -1;

export type GameMode = "race" | "garbage";
export type Opponent = "local" | "ai" | "online";
export type AiDifficulty = "easy" | "normal" | "hard";
export type PlayerId = 0 | 1;

export interface MatchConfig {
  mode: GameMode;
  opponent: Opponent;
  difficulty: AiDifficulty;
  target: number;
  seed?: number;
}

/** One tile's journey during a single move (for animation). */
export interface TileTransit {
  id: number;
  from: number;
  to: number;
  value: number;
  /** Resulting merge value when this tile absorbed another. */
  mergeValue?: number;
}

export interface SpawnEvent {
  index: number;
  value: number;
  id: number;
}

export interface MoveResult {
  moved: boolean;
  scoreGained: number;
  /** Highest merge value produced this move (0 if none). */
  maxMerge: number;
  transits: TileTransit[];
  spawn: SpawnEvent | null;
  /**
   * Garbage-mode: TTL values to queue on the opponent.
   * Each entry replaces one of their future 2/4 spawns with a blocker.
   */
  garbageTtlsSent: number[];
}

export interface PlayerState {
  cells: number[];
  /** Parallel TTL for garbage cells; 0 elsewhere. */
  garbageTtl: number[];
  /** Stable ids for DOM animation continuity. */
  ids: number[];
  score: number;
  highest: number;
  alive: boolean;
  won: boolean;
}

export type MatchStatus = "playing" | "finished";

export interface MatchState {
  config: MatchConfig;
  seed: number;
  players: [PlayerState, PlayerState];
  status: MatchStatus;
  winner: PlayerId | "draw" | null;
  /**
   * Queued garbage TTLs per player. Each entry replaces the next normal
   * 2/4 spawn with a blocker that lasts that many of the owner's moves.
   */
  pendingGarbage: [number[], number[]];
  message: string;
}
