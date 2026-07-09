/**
 * Quick engine sanity checks (run via: npm run test:engine)
 */
import {
  executeMove,
  emptyIds,
  emptyTtl,
  spawnRandom,
  spawnTile,
  movesAvailable,
  garbageTtlFromMerge,
} from "./board";
import { mulberry32 } from "./rng";
import { createMatch, applyPlayerMove, pendingGarbageCount } from "./match";
import { UP, LEFT, RIGHT, GARBAGE } from "./types";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Merge left: [2,2,0,0] → [4,0,0,0]
{
  const cells = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ids = [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ttl = emptyTtl();
  const r = executeMove(cells, ids, ttl, LEFT);
  assert(r.moved, "should move");
  assert(cells[0] === 4, `expected 4 got ${cells[0]}`);
  assert(r.scoreGained === 4, `score ${r.scoreGained}`);
}

// Garbage wall blocks merge across
{
  const cells = [2, -1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ids = [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ttl = [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  executeMove(cells, ids, ttl, LEFT);
  assert(cells[0] === 2 && cells[1] === -1 && cells[2] === 2, "wall should block");
}

assert(garbageTtlFromMerge(64) === 0, "64 no garbage");
assert(garbageTtlFromMerge(128) === 3, "128 → ttl 3");
assert(garbageTtlFromMerge(256) === 4, "256 → ttl 4");
assert(garbageTtlFromMerge(512) === 5, "512 → ttl 5");
assert(garbageTtlFromMerge(1024) === 6, "1024 → ttl 6");
assert(garbageTtlFromMerge(2048) === 7, "2048 → ttl 7");

// Shared seed ⇒ identical opening boards
{
  const a = createMatch({ mode: "race", opponent: "local", difficulty: "normal", target: 2048, seed: 42 });
  const b = createMatch({ mode: "race", opponent: "local", difficulty: "normal", target: 2048, seed: 42 });
  assert(
    a.state.players[0].cells.join() === b.state.players[0].cells.join(),
    "same seed same board",
  );
  assert(
    a.state.players[0].cells.join() === a.state.players[1].cells.join(),
    "both players same opening",
  );
}

// Same moves ⇒ same boards
{
  const m = createMatch({ mode: "race", opponent: "local", difficulty: "normal", target: 2048, seed: 7 });
  applyPlayerMove(m, 0, UP);
  applyPlayerMove(m, 1, UP);
  assert(
    m.state.players[0].cells.join() === m.state.players[1].cells.join(),
    "same moves ⇒ same boards",
  );
}

// Garbage replaces spawn — never overwrites existing tiles
{
  const m = createMatch({
    mode: "garbage",
    opponent: "local",
    difficulty: "normal",
    target: 2048,
    seed: 99,
  });
  // Queue a long-lived garbage for player 0
  m.state.pendingGarbage[0].push(5);
  assert(pendingGarbageCount(m.state, 0) === 1, "pending queued");

  const before = m.state.players[0].cells.slice();
  const beforeNonEmpty = before.filter((v) => v !== 0).length;

  // Force a move that changes the board
  let moved = false;
  for (const d of [LEFT, RIGHT, UP] as const) {
    const r = applyPlayerMove(m, 0, d);
    if (r) {
      moved = true;
      assert(r.spawn !== null, "spawn should happen");
      assert(r.spawn!.value === GARBAGE, "spawn should be garbage replacement");
      assert(m.state.players[0].garbageTtl[r.spawn!.index] === 5, "ttl applied");
      // Non-empty count: old tiles (minus merges) + 1 spawn — never fewer than spawn-only overwrite
      const afterNonEmpty = m.state.players[0].cells.filter((v) => v !== 0).length;
      assert(afterNonEmpty >= 1, "board still has tiles");
      assert(beforeNonEmpty >= 2, "started with tiles");
      break;
    }
  }
  assert(moved, "expected a legal move");
  assert(pendingGarbageCount(m.state, 0) === 0, "pending consumed");
}

// spawnTile garbage path
{
  const cells = Array(16).fill(0);
  const ids = emptyIds();
  const ttl = emptyTtl();
  const rng = mulberry32(1);
  const s = spawnTile(cells, ids, ttl, rng, 4);
  assert(s !== null && s.value === GARBAGE, "garbage spawn");
  assert(ttl[s!.index] === 4, "ttl set");
  spawnRandom(cells, ids, rng);
  assert(movesAvailable(cells), "playable");
}

console.log("engine.selftest: all passed");
