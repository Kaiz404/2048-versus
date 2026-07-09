import "./style.css";
import { AiClient } from "./ai/client";
import { getAiDelay } from "./game/ai";
import {
  applyPlayerMove,
  boardSnapshot,
  createMatch,
  pendingGarbageCount,
  playerLabel,
  type MatchRuntime,
} from "./game/match";
import type {
  AiDifficulty,
  Direction,
  GameMode,
  MatchConfig,
  Opponent,
  PlayerId,
} from "./game/types";
import { DOWN, LEFT, RIGHT, UP } from "./game/types";
import { BoardView } from "./ui/boardView";

const WASD: Record<string, Direction> = {
  w: UP,
  a: LEFT,
  s: DOWN,
  d: RIGHT,
};

const ARROWS: Record<string, Direction> = {
  ArrowUp: UP,
  ArrowLeft: LEFT,
  ArrowDown: DOWN,
  ArrowRight: RIGHT,
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

class GameApp {
  private match!: MatchRuntime;
  private views: [BoardView, BoardView];
  private ai = new AiClient();
  private aiGeneration = 0;
  /** vs AI: armed after the human's first successful move. */
  private aiArmed = false;
  private statusEl: HTMLElement;
  private seedEl: HTMLElement;
  private helpEl: HTMLElement;
  private timerEl: HTMLElement;
  private modeSelect: HTMLSelectElement;
  private opponentSelect: HTMLSelectElement;
  private difficultySelect: HTMLSelectElement;
  private targetSelect: HTMLSelectElement;
  private difficultyWrap: HTMLElement;

  private timerStart: number | null = null;
  private timerFrozenMs = 0;
  private timerRaf = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="top-bar">
        <div class="brand">
          <h1>2048</h1>
          <p class="tagline">Versus — two boards, one screen</p>
        </div>
        <div class="controls">
          <label>Mode
            <select data-mode>
              <option value="race">Race</option>
              <option value="garbage">Garbage Duel</option>
            </select>
          </label>
          <label>Opponent
            <select data-opponent>
              <option value="local">Local 1v1</option>
              <option value="ai">vs AI</option>
            </select>
          </label>
          <label data-diff-wrap>AI
            <select data-difficulty>
              <option value="easy">Easy</option>
              <option value="normal" selected>Normal</option>
              <option value="hard">Hard</option>
            </select>
          </label>
          <label>Target
            <select data-target>
              <option value="1024">1024</option>
              <option value="2048" selected>2048</option>
              <option value="4096">4096</option>
            </select>
          </label>
          <button type="button" data-new>New Game</button>
        </div>
      </div>
      <div class="meta-bar">
        <div class="timer" data-timer>00:00.000</div>
        <div class="status-bar" data-status></div>
      </div>
      <div class="arena" data-arena></div>
      <div class="help" data-help></div>
      <p class="seed-line" data-seed></p>
    `;

    const arena = root.querySelector("[data-arena]")!;
    this.views = [
      new BoardView("Player 1", "WASD"),
      new BoardView("Player 2", "Arrow keys"),
    ];
    arena.append(this.views[0].root, this.views[1].root);

    this.statusEl = root.querySelector("[data-status]")!;
    this.seedEl = root.querySelector("[data-seed]")!;
    this.helpEl = root.querySelector("[data-help]")!;
    this.timerEl = root.querySelector("[data-timer]")!;
    this.modeSelect = root.querySelector("[data-mode]")!;
    this.opponentSelect = root.querySelector("[data-opponent]")!;
    this.difficultySelect = root.querySelector("[data-difficulty]")!;
    this.targetSelect = root.querySelector("[data-target]")!;
    this.difficultyWrap = root.querySelector("[data-diff-wrap]")!;

    root.querySelector("[data-new]")!.addEventListener("click", () => this.newGame());

    const onSettingChange = () => {
      this.syncDifficultyVisibility();
      this.newGame();
      this.releaseUiFocus();
    };
    this.modeSelect.addEventListener("change", onSettingChange);
    this.opponentSelect.addEventListener("change", onSettingChange);
    this.difficultySelect.addEventListener("change", onSettingChange);
    this.targetSelect.addEventListener("change", onSettingChange);

    this.syncDifficultyVisibility();

    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.onResize());

    this.newGame();
  }

  private releaseUiFocus(): void {
    const el = document.activeElement;
    if (
      el instanceof HTMLSelectElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLButtonElement
    ) {
      el.blur();
    }
  }

  private isGameKey(e: KeyboardEvent): boolean {
    if (e.code === "Space" || e.key === " ") return true;
    if (WASD[e.key.toLowerCase()] !== undefined) return true;
    if (ARROWS[e.key] !== undefined) return true;
    return false;
  }

  private syncDifficultyVisibility(): void {
    const vsAi = this.opponentSelect.value === "ai";
    this.difficultyWrap.style.display = vsAi ? "" : "none";
  }

  private updateHelp(mode: GameMode): void {
    if (mode === "garbage") {
      this.helpEl.innerHTML = `
        <p class="help-lead">
          <strong>Garbage Duel</strong> — race to the target, but big merges attack your opponent.
        </p>
        <ul class="garbage-rules">
          <li>Merge a <strong>128</strong> → send a blocker lasting <strong>3</strong> moves</li>
          <li>Merge a <strong>256</strong> → send a blocker lasting <strong>4</strong> moves</li>
          <li>Merge a <strong>512</strong> → send a blocker lasting <strong>5</strong> moves</li>
          <li>Merge a <strong>1024</strong> → send a blocker lasting <strong>6</strong> moves</li>
          <li>Merge a <strong>2048+</strong> → send a blocker lasting <strong>7</strong> moves</li>
        </ul>
        <p class="help-note">
          Incoming garbage replaces their next <strong>2/4 spawn</strong> — it never overwrites
          existing tiles. The number on a blocker is moves left before it vanishes.
          <strong>Space</strong> resets the match.
        </p>
      `;
    } else {
      this.helpEl.innerHTML = `
        <p class="help-lead">
          <strong>Race</strong> — both boards share the same random seed, so luck is equal.
          First to the target tile wins. If a board locks up, the higher score wins.
          <strong>Space</strong> resets the match.
        </p>
      `;
    }
  }

  private readConfig(): MatchConfig {
    return {
      mode: this.modeSelect.value as GameMode,
      opponent: this.opponentSelect.value as Opponent,
      difficulty: this.difficultySelect.value as AiDifficulty,
      target: Number(this.targetSelect.value),
    };
  }

  private stopTimer(freeze = false): void {
    if (this.timerRaf) {
      cancelAnimationFrame(this.timerRaf);
      this.timerRaf = 0;
    }
    if (freeze && this.timerStart !== null) {
      this.timerFrozenMs = performance.now() - this.timerStart;
      this.timerEl.textContent = formatElapsed(this.timerFrozenMs);
    }
    this.timerStart = null;
  }

  private resetTimerDisplay(): void {
    this.stopTimer(false);
    this.timerFrozenMs = 0;
    this.timerEl.textContent = "00:00.000";
  }

  private startTimer(): void {
    if (this.timerStart !== null) return;
    this.timerStart = performance.now();
    const tick = () => {
      if (this.timerStart === null) return;
      this.timerEl.textContent = formatElapsed(performance.now() - this.timerStart);
      this.timerRaf = requestAnimationFrame(tick);
    };
    this.timerRaf = requestAnimationFrame(tick);
  }

  private pendingFor(player: PlayerId): number {
    return pendingGarbageCount(this.match.state, player);
  }

  newGame(): void {
    this.aiGeneration += 1;
    this.aiArmed = false;
    this.resetTimerDisplay();
    this.match = createMatch(this.readConfig());
    const { config } = this.match.state;
    const vsAi = config.opponent === "ai";

    this.views[0].setTitle(
      playerLabel(0, config.opponent),
      vsAi ? "WASD or Arrow keys · Space resets" : "WASD · Space resets",
    );
    this.views[1].setTitle(
      playerLabel(1, config.opponent),
      vsAi ? `${config.difficulty} AI` : "Arrow keys · Space resets",
    );

    for (let i = 0; i < 2; i++) {
      const ps = this.match.state.players[i as PlayerId];
      this.views[i]!.renderStatic(ps, this.pendingFor(i as PlayerId));
      this.views[i]!.setOverlay(null);
    }

    this.statusEl.textContent = vsAi
      ? "Make your first move to start the race!"
      : "Go! Player 1: WASD · Player 2: Arrows · Space resets";
    this.statusEl.classList.remove("win");
    this.seedEl.textContent = `Seed ${this.match.state.seed} · fair shared RNG`;
    this.updateHelp(config.mode);
    this.releaseUiFocus();
  }

  private onResize(): void {
    for (let i = 0; i < 2; i++) {
      this.views[i]!.renderStatic(
        this.match.state.players[i as PlayerId],
        this.pendingFor(i as PlayerId),
      );
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    const onFormControl = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

    // Dropdowns keep focus after a change — steal game keys back for play.
    if (onFormControl && this.isGameKey(e)) {
      e.preventDefault();
      this.releaseUiFocus();
    } else if (onFormControl) {
      return;
    }

    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      this.newGame();
      return;
    }

    const { opponent } = this.match.state.config;
    let player: PlayerId | null = null;
    let dir: Direction | undefined;

    if (opponent === "ai") {
      dir = WASD[e.key.toLowerCase()] ?? ARROWS[e.key];
      if (dir !== undefined) player = 0;
    } else {
      const wasd = WASD[e.key.toLowerCase()];
      if (wasd !== undefined) {
        player = 0;
        dir = wasd;
      } else if (ARROWS[e.key] !== undefined) {
        player = 1;
        dir = ARROWS[e.key];
      }
    }

    if (player === null || dir === undefined) return;
    e.preventDefault();
    void this.tryMove(player, dir);
  }

  private async tryMove(player: PlayerId, dir: Direction): Promise<boolean> {
    if (this.match.state.status !== "playing") return false;
    if (!this.match.state.players[player].alive) return false;

    const result = applyPlayerMove(this.match, player, dir);
    if (!result) return false;

    // First successful move starts the clock (and arms the AI in vs-AI).
    this.startTimer();
    if (
      player === 0 &&
      this.match.state.config.opponent === "ai" &&
      !this.aiArmed
    ) {
      this.aiArmed = true;
      this.statusEl.textContent = "Race on — beat the AI!";
      this.scheduleAi();
    }

    const after = this.match.state.players[player];
    await this.views[player]!.playMove(
      after,
      result,
      this.pendingFor(player),
    );

    const opp = (player === 0 ? 1 : 0) as PlayerId;
    this.views[opp]!.syncScores(
      this.match.state.players[opp],
      this.pendingFor(opp),
    );

    this.refreshOverlays();
    this.updateStatus();

    // applyPlayerMove may have finished the match (TS still thinks status is "playing").
    if (this.match.state.winner !== null) {
      this.stopTimer(true);
    }
    return true;
  }

  private refreshOverlays(): void {
    const { state } = this.match;
    for (let i = 0; i < 2; i++) {
      const ps = state.players[i as PlayerId];
      if (state.status === "finished") {
        if (state.winner === "draw") {
          this.views[i]!.setOverlay("Draw");
        } else if (state.winner === i) {
          this.views[i]!.setOverlay("Winner!");
        } else {
          this.views[i]!.setOverlay(ps.alive ? "—" : "Game over");
        }
      } else if (!ps.alive) {
        this.views[i]!.setOverlay("Game over");
      } else {
        this.views[i]!.setOverlay(null);
      }
    }
  }

  private updateStatus(): void {
    const { state } = this.match;
    if (state.status === "finished") {
      this.statusEl.classList.add("win");
      if (state.winner === "draw") {
        this.statusEl.textContent = state.message || "Draw!";
      } else if (state.winner !== null) {
        const name = playerLabel(state.winner, state.config.opponent);
        this.statusEl.textContent = state.message || `${name} wins!`;
      }
      return;
    }
    this.statusEl.classList.remove("win");
    if (state.message) {
      this.statusEl.textContent = state.message;
    }
  }

  private scheduleAi(): void {
    const { state } = this.match;
    if (state.config.opponent !== "ai") return;
    if (!this.aiArmed) return;
    if (state.status !== "playing") return;
    if (!state.players[1].alive) return;

    const gen = this.aiGeneration;
    const delay = getAiDelay(state.config.difficulty);

    window.setTimeout(() => {
      void this.runAiTurn(gen);
    }, delay);
  }

  private async runAiTurn(gen: number): Promise<void> {
    if (gen !== this.aiGeneration) return;
    const { state } = this.match;
    if (state.status !== "playing" || !state.players[1].alive) return;

    const cells = boardSnapshot(state.players[1]);
    const move = await this.ai.request(cells, state.config.difficulty);
    if (gen !== this.aiGeneration) return;
    if (move === null) return;
    if (this.match.state.status !== "playing") return;

    await this.tryMove(1, move);

    if (gen === this.aiGeneration && this.match.state.status === "playing") {
      this.scheduleAi();
    }
  }
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  new GameApp(app);
}
