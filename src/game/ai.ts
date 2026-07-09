/**
 * Lightweight expectimax for browser play.
 * Heuristic weights follow nneonneo / the project's Python solver.
 * Runs inside a Web Worker — keep this module DOM-free.
 */

import { GARBAGE, SIZE, type Direction } from "./types";

const SCORE_LOST_PENALTY = 200000;
const SCORE_MONOTONICITY_POWER = 4;
const SCORE_MONOTONICITY_WEIGHT = 47;
const SCORE_SUM_POWER = 3.5;
const SCORE_SUM_WEIGHT = 11;
const SCORE_MERGES_WEIGHT = 700;
const SCORE_EMPTY_WEIGHT = 270;
const PROB_THRESH = 1e-4;

type Board = number[];

function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function clone(b: Board): Board {
  return b.slice();
}

function slideLineValues(line: number[]): { out: number[]; changed: boolean } {
  const walls = line.map((v) => v === GARBAGE);

  // Rebuild with garbage fixed in place.
  const out = Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    if (walls[i]) out[i] = GARBAGE;
  }

  let segStart = 0;
  const writeSeg = (from: number, to: number) => {
    const vals: number[] = [];
    for (let i = from; i < to; i++) {
      if (line[i] !== 0 && line[i] !== GARBAGE) vals.push(line[i]!);
    }
    const merged: number[] = [];
    for (let i = 0; i < vals.length; ) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
        merged.push(vals[i]! * 2);
        i += 2;
      } else {
        merged.push(vals[i]!);
        i += 1;
      }
    }
    for (let i = 0; i < merged.length; i++) {
      out[from + i] = merged[i]!;
    }
  };

  for (let i = 0; i <= SIZE; i++) {
    if (i === SIZE || walls[i]) {
      writeSeg(segStart, i);
      segStart = i + 1;
    }
  }

  let changed = false;
  for (let i = 0; i < SIZE; i++) {
    if (out[i] !== line[i]) changed = true;
  }
  return { out, changed };
}

function moveBoard(board: Board, dir: Direction): { board: Board; moved: boolean } {
  const next = clone(board);
  let moved = false;

  for (let line = 0; line < SIZE; line++) {
    const values: number[] = [];
    const positions: number[] = [];

    if (dir === 3) {
      // LEFT
      for (let c = 0; c < SIZE; c++) {
        positions.push(idx(line, c));
        values.push(board[idx(line, c)]!);
      }
    } else if (dir === 1) {
      // RIGHT
      for (let c = SIZE - 1; c >= 0; c--) {
        positions.push(idx(line, c));
        values.push(board[idx(line, c)]!);
      }
    } else if (dir === 0) {
      // UP
      for (let r = 0; r < SIZE; r++) {
        positions.push(idx(r, line));
        values.push(board[idx(r, line)]!);
      }
    } else {
      // DOWN
      for (let r = SIZE - 1; r >= 0; r--) {
        positions.push(idx(r, line));
        values.push(board[idx(r, line)]!);
      }
    }

    const { out, changed } = slideLineValues(values);
    if (changed) moved = true;
    for (let i = 0; i < SIZE; i++) {
      next[positions[i]!] = out[i]!;
    }
  }

  return { board: next, moved };
}

function empties(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    if (board[i] === 0) out.push(i);
  }
  return out;
}

function heuristic(board: Board): number {
  let total = 0;

  const scoreLine = (line: number[]) => {
    let sum = 0;
    let empty = 0;
    let merges = 0;
    let prev = 0;
    let counter = 0;

    for (const raw of line) {
      // Rank matches nibble encoding: log2(tile). Garbage acts like a wall/empty.
      const rank = raw === GARBAGE || raw === 0 ? 0 : Math.log2(raw);
      sum += rank ** SCORE_SUM_POWER;
      if (raw === 0) empty += 1;
      else if (raw !== GARBAGE) {
        if (prev === rank && rank > 0) counter += 1;
        else if (counter > 0) {
          merges += 1 + counter;
          counter = 0;
        }
        prev = rank;
      } else {
        if (counter > 0) merges += 1 + counter;
        counter = 0;
        prev = 0;
      }
    }
    if (counter > 0) merges += 1 + counter;

    let monoLeft = 0;
    let monoRight = 0;
    const ranks = line.map((raw) =>
      raw === GARBAGE || raw === 0 ? 0 : Math.log2(raw),
    );
    for (let i = 1; i < 4; i++) {
      const a = ranks[i - 1]!;
      const b = ranks[i]!;
      if (a > b) monoLeft += a ** SCORE_MONOTONICITY_POWER - b ** SCORE_MONOTONICITY_POWER;
      else monoRight += b ** SCORE_MONOTONICITY_POWER - a ** SCORE_MONOTONICITY_POWER;
    }

    return (
      SCORE_LOST_PENALTY +
      SCORE_EMPTY_WEIGHT * empty +
      SCORE_MERGES_WEIGHT * merges -
      SCORE_MONOTONICITY_WEIGHT * Math.min(monoLeft, monoRight) -
      SCORE_SUM_WEIGHT * sum
    );
  };

  for (let r = 0; r < SIZE; r++) {
    total += scoreLine([
      board[idx(r, 0)]!,
      board[idx(r, 1)]!,
      board[idx(r, 2)]!,
      board[idx(r, 3)]!,
    ]);
  }
  for (let c = 0; c < SIZE; c++) {
    total += scoreLine([
      board[idx(0, c)]!,
      board[idx(1, c)]!,
      board[idx(2, c)]!,
      board[idx(3, c)]!,
    ]);
  }
  return total;
}

function movesAvailable(board: Board): boolean {
  if (empties(board).length > 0) return true;
  for (let d = 0; d < 4; d++) {
    if (moveBoard(board, d as Direction).moved) return true;
  }
  return false;
}

interface SearchCtx {
  budget: number;
  nodes: number;
}

function expectimax(board: Board, depth: number, cprob: number, ctx: SearchCtx): number {
  if (depth <= 0 || cprob < PROB_THRESH || ctx.budget <= 0) {
    return heuristic(board);
  }
  ctx.budget -= 1;
  ctx.nodes += 1;

  let best = -Infinity;
  let any = false;

  for (let d = 0; d < 4; d++) {
    const { board: next, moved } = moveBoard(board, d as Direction);
    if (!moved) continue;
    any = true;

    const slots = empties(next);
    if (slots.length === 0) {
      best = Math.max(best, heuristic(next));
      continue;
    }

    // Cap chance branching for speed (hard uses a higher cap via chooseAiMove root).
    const sample = slots.length > 8
      ? slots.filter((_, i) => i % Math.ceil(slots.length / 8) === 0).slice(0, 8)
      : slots;

    let expect = 0;
    const inv = 1 / sample.length;
    for (const pos of sample) {
      const b2 = clone(next);
      b2[pos] = 2;
      expect += 0.9 * expectimax(b2, depth - 1, cprob * inv * 0.9, ctx);
      const b4 = clone(next);
      b4[pos] = 4;
      expect += 0.1 * expectimax(b4, depth - 1, cprob * inv * 0.1, ctx);
    }
    expect *= inv;
    if (expect > best) best = expect;
  }

  if (!any) return 0;
  return best;
}

export type AiDifficulty = "easy" | "normal" | "hard";

/**
 * Difficulty ladder (browser-friendly):
 * - Easy / Normal keep solid expectimax quality
 * - Hard matches Normal's search cost (depth 3) so the tab stays smooth,
 *   then wins on pace (lower delay) and a slightly larger node budget
 */
const DIFFICULTY: Record<
  AiDifficulty,
  { depth: number; budget: number; mistakeRate: number; delayMs: number; sampleCap: number }
> = {
  easy: { depth: 2, budget: 1200, mistakeRate: 0.08, delayMs: 120, sampleCap: 8 },
  normal: { depth: 3, budget: 8000, mistakeRate: 0, delayMs: 40, sampleCap: 8 },
  hard: { depth: 3, budget: 12000, mistakeRate: 0, delayMs: 12, sampleCap: 10 },
};

export function getAiDelay(difficulty: AiDifficulty): number {
  return DIFFICULTY[difficulty].delayMs;
}

export function chooseAiMove(
  cells: number[],
  difficulty: AiDifficulty,
): Direction | null {
  const board: Board = cells.slice();
  const legal: Direction[] = [];
  for (let d = 0; d < 4; d++) {
    if (moveBoard(board, d as Direction).moved) legal.push(d as Direction);
  }
  if (legal.length === 0) return null;

  const cfg = DIFFICULTY[difficulty];

  // Easy / normal: occasionally pick a random legal move.
  if (cfg.mistakeRate > 0 && Math.random() < cfg.mistakeRate) {
    return legal[Math.floor(Math.random() * legal.length)]!;
  }

  const ctx: SearchCtx = { budget: cfg.budget, nodes: 0 };
  let bestDir = legal[0]!;
  let bestVal = -Infinity;

  for (const d of legal) {
    const { board: next } = moveBoard(board, d);
    const slots = empties(next);
    let val: number;
    if (slots.length === 0) {
      val = heuristic(next);
    } else {
      const cap = cfg.sampleCap;
      const sample =
        slots.length > cap
          ? slots.filter((_, i) => i % Math.ceil(slots.length / cap) === 0).slice(0, cap)
          : slots;
      val = 0;
      const inv = 1 / sample.length;
      for (const pos of sample) {
        const b2 = clone(next);
        b2[pos] = 2;
        val += 0.9 * expectimax(b2, cfg.depth - 1, inv * 0.9, ctx);
        const b4 = clone(next);
        b4[pos] = 4;
        val += 0.1 * expectimax(b4, cfg.depth - 1, inv * 0.1, ctx);
      }
      val *= inv;
    }
    if (val > bestVal) {
      bestVal = val;
      bestDir = d;
    }
  }

  // Prefer not to suicide if heuristic is confused.
  if (!movesAvailable(moveBoard(board, bestDir).board) && legal.length > 1) {
    for (const d of legal) {
      if (movesAvailable(moveBoard(board, d).board)) return d;
    }
  }

  return bestDir;
}
