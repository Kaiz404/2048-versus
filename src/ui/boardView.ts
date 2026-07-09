import type { MoveResult, PlayerState, SpawnEvent, TileTransit } from "../game/types";
import { GARBAGE } from "../game/types";

/** Keep short so queued moves from fast play still feel snappy. */
const ANIM_MS = 55;

const TILE_CLASS: Record<number, string> = {
  2: "tile-2",
  4: "tile-4",
  8: "tile-8",
  16: "tile-16",
  32: "tile-32",
  64: "tile-64",
  128: "tile-128",
  256: "tile-256",
  512: "tile-512",
  1024: "tile-1024",
  2048: "tile-2048",
};

function tileClass(value: number): string {
  if (value === GARBAGE) return "tile-garbage";
  if (value >= 4096) return "tile-super";
  return TILE_CLASS[value] ?? "tile-super";
}

function formatValue(value: number, ttl = 0): string {
  if (value === GARBAGE) return ttl > 0 ? String(ttl) : "";
  return String(value);
}

interface QueuedMove {
  after: PlayerState;
  result: MoveResult;
  pendingGarbage: number;
  resolve: () => void;
}

export class BoardView {
  readonly root: HTMLElement;
  private grid: HTMLElement;
  private tileLayer: HTMLElement;
  private scoreEl: HTMLElement;
  private bestEl: HTMLElement;
  private pendingEl: HTMLElement;
  private overlay: HTMLElement;
  private cellSize = 0;
  private gap = 0;
  private draining = false;
  private queue: QueuedMove[] = [];

  constructor(
    title: string,
    controlsHint: string,
  ) {
    this.root = document.createElement("section");
    this.root.className = "player-panel";

    this.root.innerHTML = `
      <header class="player-header">
        <div>
          <h2 class="player-title"></h2>
          <p class="player-controls"></p>
        </div>
        <div class="scores">
          <div class="score-box">
            <span class="score-label">Score</span>
            <span class="score-value" data-score>0</span>
          </div>
          <div class="score-box">
            <span class="score-label">Best</span>
            <span class="score-value" data-best>0</span>
          </div>
        </div>
      </header>
      <div class="pending-garbage" data-pending hidden></div>
      <div class="board-wrap">
        <div class="grid-bg"></div>
        <div class="tile-layer"></div>
        <div class="board-overlay" hidden></div>
      </div>
    `;

    this.root.querySelector(".player-title")!.textContent = title;
    this.root.querySelector(".player-controls")!.textContent = controlsHint;
    this.scoreEl = this.root.querySelector("[data-score]")!;
    this.bestEl = this.root.querySelector("[data-best]")!;
    this.pendingEl = this.root.querySelector("[data-pending]")!;
    this.grid = this.root.querySelector(".grid-bg")!;
    this.tileLayer = this.root.querySelector(".tile-layer")!;
    this.overlay = this.root.querySelector(".board-overlay")!;

    for (let i = 0; i < 16; i++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      this.grid.appendChild(cell);
    }
  }

  setTitle(title: string, hint: string): void {
    this.root.querySelector(".player-title")!.textContent = title;
    this.root.querySelector(".player-controls")!.textContent = hint;
  }

  measure(): void {
    const cell = this.grid.querySelector(".grid-cell") as HTMLElement | null;
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    this.cellSize = rect.width;
    const style = getComputedStyle(this.grid);
    this.gap = parseFloat(style.gap) || 10;
  }

  private pos(index: number): { x: number; y: number } {
    const r = Math.floor(index / 4);
    const c = index % 4;
    const step = this.cellSize + this.gap;
    return { x: c * step, y: r * step };
  }

  syncScores(ps: PlayerState, pendingGarbage: number): void {
    this.scoreEl.textContent = String(ps.score);
    this.bestEl.textContent = String(ps.highest);
    if (pendingGarbage > 0) {
      this.pendingEl.hidden = false;
      this.pendingEl.textContent =
        pendingGarbage === 1
          ? "Next spawn: garbage"
          : `Next ${pendingGarbage} spawns: garbage`;
    } else {
      this.pendingEl.hidden = true;
    }
  }

  setOverlay(text: string | null): void {
    if (!text) {
      this.overlay.hidden = true;
      this.overlay.classList.remove("is-visible");
      this.overlay.textContent = "";
      return;
    }
    this.overlay.hidden = false;
    this.overlay.classList.add("is-visible");
    this.overlay.textContent = text;
  }

  /** Instant full redraw (new game / resize). Drops any queued animations. */
  renderStatic(ps: PlayerState, pendingGarbage = 0): void {
    for (const item of this.queue) item.resolve();
    this.queue = [];
    this.measure();
    this.tileLayer.replaceChildren();
    for (let i = 0; i < 16; i++) {
      const v = ps.cells[i]!;
      if (v === 0) continue;
      this.tileLayer.appendChild(
        this.makeTile(ps.ids[i]!, v, i, false, ps.garbageTtl[i] ?? 0),
      );
    }
    this.syncScores(ps, pendingGarbage);
  }

  private makeTile(
    id: number,
    value: number,
    index: number,
    appear: boolean,
    ttl = 0,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = `tile ${tileClass(value)}`;
    if (appear) el.classList.add("tile-new");
    el.dataset.id = String(id);
    el.textContent = formatValue(value, ttl);
    const { x, y } = this.pos(index);
    el.style.transform = `translate(${x}px, ${y}px)`;
    return el;
  }

  /**
   * Queue a move animation. Fast input never cancels — each move plays in order
   * at the short ANIM_MS duration so the board stays visually continuous.
   */
  playMove(
    after: PlayerState,
    result: MoveResult,
    pendingGarbage: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ after, result, pendingGarbage, resolve });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.animateFrame(item.after, item.result, item.pendingGarbage);
        item.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  private async animateFrame(
    after: PlayerState,
    result: MoveResult,
    pendingGarbage: number,
  ): Promise<void> {
    this.measure();
    const byId = new Map<string, HTMLElement>();
    for (const el of Array.from(this.tileLayer.children) as HTMLElement[]) {
      byId.set(el.dataset.id!, el);
    }

    for (const t of result.transits) {
      let el = byId.get(String(t.id));
      if (!el) {
        el = this.makeTile(t.id, t.value, t.from, false);
        this.tileLayer.appendChild(el);
        byId.set(String(t.id), el);
      }
      const dest = this.pos(t.to);
      void el.offsetWidth;
      el.style.transition = `transform ${ANIM_MS}ms ease-in-out`;
      el.style.transform = `translate(${dest.x}px, ${dest.y}px)`;
    }

    await wait(ANIM_MS);
    this.applyMergeDom(result.transits, after);
    this.syncBoard(after, result.spawn);
    this.syncScores(after, pendingGarbage);
  }

  private applyMergeDom(transits: TileTransit[], after: PlayerState): void {
    const byTo = new Map<number, TileTransit[]>();
    for (const t of transits) {
      if (!t.mergeValue) continue;
      const list = byTo.get(t.to) ?? [];
      list.push(t);
      byTo.set(t.to, list);
    }

    for (const [to, group] of byTo) {
      const survivorId = after.ids[to]!;
      for (const t of group) {
        const el = this.tileLayer.querySelector(
          `[data-id="${t.id}"]`,
        ) as HTMLElement | null;
        if (!el) continue;
        if (t.id === survivorId) {
          el.textContent = formatValue(t.mergeValue!);
          el.className = `tile ${tileClass(t.mergeValue!)} tile-merged`;
          el.style.transition = "";
        } else {
          el.remove();
        }
      }
    }
  }

  private syncBoard(after: PlayerState, spawn: SpawnEvent | null): void {
    const existing = new Map<string, HTMLElement>();
    for (const el of Array.from(this.tileLayer.children) as HTMLElement[]) {
      existing.set(el.dataset.id!, el);
    }

    const needed = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const id = after.ids[i]!;
      const value = after.cells[i]!;
      if (value === 0 || id === 0) continue;
      needed.add(String(id));
      let el = existing.get(String(id));
      const { x, y } = this.pos(i);
      const ttl = after.garbageTtl[i] ?? 0;
      if (!el) {
        const isNew = spawn !== null && spawn.id === id;
        el = this.makeTile(id, value, i, isNew, ttl);
        this.tileLayer.appendChild(el);
      } else {
        el.textContent = formatValue(value, ttl);
        el.className = `tile ${tileClass(value)}`;
        if (spawn && spawn.id === id) el.classList.add("tile-new");
        el.style.transition = "";
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    }

    for (const [id, el] of existing) {
      if (!needed.has(id)) el.remove();
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
