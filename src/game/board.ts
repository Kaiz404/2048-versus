import { CELLS, GARBAGE, SIZE, type Direction, type MoveResult, type SpawnEvent, type TileTransit } from "./types";
import type { Rng } from "./rng";

let nextTileId = 1;

export function freshTileId(): number {
  return nextTileId++;
}

export function resetTileIds(start = 1): void {
  nextTileId = start;
}

export function emptyBoard(): number[] {
  return Array(CELLS).fill(0);
}

export function emptyIds(): number[] {
  return Array(CELLS).fill(0);
}

export function emptyTtl(): number[] {
  return Array(CELLS).fill(0);
}

export function cloneCells(cells: number[]): number[] {
  return cells.slice();
}

export function maxTile(cells: number[]): number {
  let m = 0;
  for (const v of cells) {
    if (v > m) m = v;
  }
  return m;
}

export function countEmpty(cells: number[]): number {
  let n = 0;
  for (const v of cells) {
    if (v === 0) n++;
  }
  return n;
}

export function emptyIndices(cells: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] === 0) out.push(i);
  }
  return out;
}

/**
 * Spawn into a random empty cell.
 * If `garbageTtl` is set, place a blocker instead of a 2/4 (spawn replacement).
 */
export function spawnTile(
  cells: number[],
  ids: number[],
  ttl: number[],
  rng: Rng,
  garbageTtl?: number,
): SpawnEvent | null {
  const empties = emptyIndices(cells);
  if (empties.length === 0) return null;
  const index = empties[Math.floor(rng() * empties.length)]!;
  const id = freshTileId();

  if (garbageTtl !== undefined && garbageTtl > 0) {
    cells[index] = GARBAGE;
    ids[index] = id;
    ttl[index] = garbageTtl;
    return { index, value: GARBAGE, id };
  }

  const value = rng() < 0.9 ? 2 : 4;
  cells[index] = value;
  ids[index] = id;
  ttl[index] = 0;
  return { index, value, id };
}

/** Classic opening spawn (always a normal 2/4). */
export function spawnRandom(cells: number[], ids: number[], rng: Rng): SpawnEvent | null {
  return spawnTile(cells, ids, emptyTtl(), rng);
}

/**
 * TTL granted by a merge in garbage mode.
 * Bigger merges → longer-lasting single blocker (not more blockers).
 * 128→3, 256→4, 512→5, 1024→6, 2048+→7
 */
export function garbageTtlFromMerge(value: number): number {
  if (value < 128) return 0;
  const steps = Math.log2(value) - 7; // 128 → 0
  return Math.min(7, Math.max(3, 3 + Math.floor(steps)));
}

/** Tick garbage lifetimes after a successful move; remove expired blockers. */
export function tickGarbage(cells: number[], ids: number[], ttl: number[]): void {
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] !== GARBAGE) continue;
    ttl[i] -= 1;
    if (ttl[i] <= 0) {
      cells[i] = 0;
      ids[i] = 0;
      ttl[i] = 0;
    }
  }
}

function index(r: number, c: number): number {
  return r * SIZE + c;
}

/**
 * Slide one line toward the start (index 0).
 * Garbage cells act as fixed walls: tiles slide within segments between them.
 */
function slideLine(
  values: number[],
  ids: number[],
  ttl: number[],
  lineIdx: number[],
): { score: number; maxMerge: number; garbageTtls: number[]; transits: TileTransit[] } {
  const transits: TileTransit[] = [];
  let score = 0;
  let maxMerge = 0;
  const garbageTtls: number[] = [];

  let segStart = 0;
  const flushSegment = (from: number, to: number) => {
    const slots = lineIdx.slice(from, to);
    if (slots.length === 0) return;

    const tiles: { value: number; id: number; from: number }[] = [];
    for (const slot of slots) {
      const v = values[slot]!;
      if (v !== 0 && v !== GARBAGE) {
        tiles.push({ value: v, id: ids[slot]!, from: slot });
      }
    }

    for (const slot of slots) {
      if (values[slot] !== GARBAGE) {
        values[slot] = 0;
        ids[slot] = 0;
        ttl[slot] = 0;
      }
    }

    let write = 0;
    let read = 0;
    while (read < tiles.length) {
      const cur = tiles[read]!;
      if (read + 1 < tiles.length && tiles[read + 1]!.value === cur.value) {
        const other = tiles[read + 1]!;
        const merged = cur.value * 2;
        const dest = slots[write]!;
        values[dest] = merged;
        ids[dest] = cur.id;
        ttl[dest] = 0;
        score += merged;
        if (merged > maxMerge) maxMerge = merged;
        const gTtl = garbageTtlFromMerge(merged);
        if (gTtl > 0) garbageTtls.push(gTtl);
        transits.push({
          id: cur.id,
          from: cur.from,
          to: dest,
          value: cur.value,
          mergeValue: merged,
        });
        transits.push({
          id: other.id,
          from: other.from,
          to: dest,
          value: other.value,
          mergeValue: merged,
        });
        read += 2;
        write += 1;
      } else {
        const dest = slots[write]!;
        values[dest] = cur.value;
        ids[dest] = cur.id;
        ttl[dest] = 0;
        transits.push({
          id: cur.id,
          from: cur.from,
          to: dest,
          value: cur.value,
        });
        read += 1;
        write += 1;
      }
    }
  };

  for (let i = 0; i <= lineIdx.length; i++) {
    const atEnd = i === lineIdx.length;
    const isWall = !atEnd && values[lineIdx[i]!] === GARBAGE;
    if (atEnd || isWall) {
      flushSegment(segStart, i);
      segStart = i + (isWall ? 1 : 0);
    }
  }

  return { score, maxMerge, garbageTtls, transits };
}

function lineIndices(dir: Direction, line: number): number[] {
  const idx: number[] = [];
  if (dir === 3 /* LEFT */) {
    for (let c = 0; c < SIZE; c++) idx.push(index(line, c));
  } else if (dir === 1 /* RIGHT */) {
    for (let c = SIZE - 1; c >= 0; c--) idx.push(index(line, c));
  } else if (dir === 0 /* UP */) {
    for (let r = 0; r < SIZE; r++) idx.push(index(r, line));
  } else {
    for (let r = SIZE - 1; r >= 0; r--) idx.push(index(r, line));
  }
  return idx;
}

/**
 * Execute a move on a board. Mutates cells/ids/ttl.
 * Returns animation metadata and scoring; spawn is NOT applied here.
 */
export function executeMove(
  cells: number[],
  ids: number[],
  ttl: number[],
  dir: Direction,
): Omit<MoveResult, "spawn" | "moved"> & { moved: boolean } {
  const before = cells.join(",");
  const allTransits: TileTransit[] = [];
  let scoreGained = 0;
  let maxMerge = 0;
  const garbageTtlsSent: number[] = [];

  for (let line = 0; line < SIZE; line++) {
    const result = slideLine(cells, ids, ttl, lineIndices(dir, line));
    scoreGained += result.score;
    if (result.maxMerge > maxMerge) maxMerge = result.maxMerge;
    garbageTtlsSent.push(...result.garbageTtls);
    allTransits.push(...result.transits);
  }

  const moved = cells.join(",") !== before;
  return {
    moved,
    scoreGained: moved ? scoreGained : 0,
    maxMerge: moved ? maxMerge : 0,
    garbageTtlsSent: moved ? garbageTtlsSent : [],
    transits: moved ? allTransits.filter((t) => t.from !== t.to || t.mergeValue) : [],
  };
}

export function movesAvailable(cells: number[]): boolean {
  if (countEmpty(cells) > 0) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = cells[index(r, c)]!;
      if (v === GARBAGE) continue;
      if (c + 1 < SIZE) {
        const right = cells[index(r, c + 1)]!;
        if (right === v && v !== 0) return true;
      }
      if (r + 1 < SIZE) {
        const down = cells[index(r + 1, c)]!;
        if (down === v && v !== 0) return true;
      }
    }
  }
  return false;
}

/** Probe whether a direction changes the board (no mutation of caller's arrays). */
export function canMove(cells: number[], dir: Direction): boolean {
  const probe = cells.slice();
  const ids = emptyIds();
  const ttl = emptyTtl();
  for (let i = 0; i < CELLS; i++) {
    if (probe[i] === GARBAGE) ttl[i] = 1;
  }
  const result = executeMove(probe, ids, ttl, dir);
  return result.moved;
}
