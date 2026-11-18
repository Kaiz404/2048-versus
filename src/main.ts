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
import { randomSeed } from "./game/rng";
import type {
  AiDifficulty,
  Direction,
  GameMode,
  MatchConfig,
  Opponent,
  PlayerId,
} from "./game/types";
import { DOWN, LEFT, RIGHT, UP } from "./game/types";
import { WsRoom, type RoomHello, type RoomStatus } from "./net/wsRoom";
import {
  RelayHealthMonitor,
  type RelayHealthSnapshot,
} from "./net/relayHealth";
import { BoardView } from "./ui/boardView";
import { Coach } from "./ui/coach";

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
  private aiArmed = false;

  private statusEl: HTMLElement;
  private seedEl: HTMLElement;
  private helpEl: HTMLElement;
  private timerEl: HTMLElement;
  private pingEl: HTMLElement;
  private roomPanel: HTMLElement;
  private roomStatusEl: HTMLElement;
  private roomCodeEl: HTMLElement;
  private roomLogEl: HTMLElement;
  private roomInput: HTMLInputElement;
  private copyBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private opponentSelect: HTMLSelectElement;
  private difficultySelect: HTMLSelectElement;
  private targetSelect: HTMLSelectElement;
  private difficultyWrap: HTMLElement;
  private coach!: Coach;
  private taglineEl!: HTMLElement;

  private timerStart: number | null = null;
  private timerFrozenMs = 0;
  private timerRaf = 0;

  private room: WsRoom | null = null;
  private onlineReady = false;
  private onlineHelloSent = false;
  private lastPingMs: number | null = null;
  private relayHealth = new RelayHealthMonitor();
  private relayHealthEl!: HTMLElement;
  private hostBtn!: HTMLButtonElement;
  private joinBtn!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="top-bar">
        <div class="brand">
          <h1>2048</h1>
          <p class="tagline">You vs a bot</p>
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
              <option value="ai" selected>vs AI</option>
              <option value="local">Local 1v1</option>
              <option value="online">Online</option>
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

      <div class="room-panel" data-room-panel hidden>
        <div class="relay-health" data-relay-health aria-live="polite">
          Checking multiplayer server…
        </div>
        <div class="room-row">
          <button type="button" data-host>Create Room</button>
          <div class="room-join">
            <input data-room-input maxlength="6" placeholder="Room code" spellcheck="false" autocomplete="off" />
            <button type="button" data-join>Join</button>
          </div>
          <button type="button" data-copy hidden>Copy Code</button>
          <button type="button" data-leave hidden>Leave</button>
        </div>
        <p class="room-status" data-room-status>Create a room and share the code, or join a friend.</p>
        <p class="room-code" data-room-code hidden></p>
        <details class="room-log-wrap">
          <summary>Connection details</summary>
          <pre class="room-log" data-room-log></pre>
        </details>
      </div>

      <div class="meta-bar">
        <div class="timer" data-timer>00:00.000</div>
        <div class="ping" data-ping hidden>Ping —</div>
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
    this.relayHealthEl = root.querySelector("[data-relay-health]")!;
    this.pingEl = root.querySelector("[data-ping]")!;
    this.roomPanel = root.querySelector("[data-room-panel]")!;
    this.roomStatusEl = root.querySelector("[data-room-status]")!;
    this.roomCodeEl = root.querySelector("[data-room-code]")!;
    this.roomLogEl = root.querySelector("[data-room-log]")!;
    this.roomInput = root.querySelector("[data-room-input]")!;
    this.copyBtn = root.querySelector("[data-copy]")!;
    this.leaveBtn = root.querySelector("[data-leave]")!;
    this.hostBtn = root.querySelector("[data-host]")!;
    this.joinBtn = root.querySelector("[data-join]")!;
    this.modeSelect = root.querySelector("[data-mode]")!;
    this.opponentSelect = root.querySelector("[data-opponent]")!;
    this.difficultySelect = root.querySelector("[data-difficulty]")!;
    this.targetSelect = root.querySelector("[data-target]")!;
    this.difficultyWrap = root.querySelector("[data-diff-wrap]")!;
    this.taglineEl = root.querySelector(".tagline")!;

    const meta = root.querySelector(".meta-bar")!;
    this.coach = new Coach(meta, [this.views[0].root, this.views[1].root], () =>
      this.onCoachDone(),
    );
    this.helpEl.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof Element) || !target.closest("[data-tips]")) return;
      if (!this.isOnline() && this.match?.state.status !== "playing") this.newGame();
      this.coach.start(Number(this.targetSelect.value), true);
      this.helpEl.hidden = true;
      if (!this.statusEl.classList.contains("win")) {
        this.statusEl.textContent = "";
      }
    });
    this.bindSwipe(arena);

    root.querySelector("[data-new]")!.addEventListener("click", () => this.onNewGameClick());
    this.hostBtn.addEventListener("click", () => void this.hostRoom());
    this.joinBtn.addEventListener("click", () => void this.joinRoom());
    this.leaveBtn.addEventListener("click", () => this.leaveRoom());
    this.copyBtn.addEventListener("click", () => void this.copyRoomCode());

    this.roomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.joinRoom();
      }
    });

    this.relayHealth.subscribe((snap) => this.onRelayHealth(snap));
    this.relayHealth.start();

    const onSettingChange = () => {
      this.syncChrome();
      if (this.isOnline()) {
        // Guest cannot change match rules; host applies on next restart.
        if (this.room?.getRole() === "host" && this.room.isConnected()) {
          this.hostRestartMatch();
        } else if (this.room?.getRole() !== "guest") {
          this.newGame();
        }
      } else {
        this.newGame();
      }
      this.releaseUiFocus();
    };
    this.modeSelect.addEventListener("change", onSettingChange);
    this.opponentSelect.addEventListener("change", () => {
      if (!this.isOnline() && this.room) this.leaveRoom();
      this.syncChrome();
      this.newGame();
      this.releaseUiFocus();
    });
    this.difficultySelect.addEventListener("change", onSettingChange);
    this.targetSelect.addEventListener("change", onSettingChange);

    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.onResize());

    this.syncChrome();
    this.newGame();
  }

  private isOnline(): boolean {
    return this.opponentSelect.value === "online";
  }

  /** Host = seat 0, guest = seat 1. Offline modes use natural seats. */
  private localSeat(): PlayerId {
    if (this.isOnline() && this.room?.getRole() === "guest") return 1;
    return 0;
  }

  private remoteSeat(): PlayerId {
    return this.localSeat() === 0 ? 1 : 0;
  }

  private viewForSeat(seat: PlayerId): BoardView {
    if (!this.isOnline()) return this.views[seat]!;
    return seat === this.localSeat() ? this.views[0]! : this.views[1]!;
  }

  private pendingFor(player: PlayerId): number {
    return pendingGarbageCount(this.match.state, player);
  }

  private onRelayHealth(snap: RelayHealthSnapshot): void {
    this.relayHealthEl.textContent = snap.detail;
    this.relayHealthEl.dataset.state = snap.status;
    // Chip lives in the Online room panel — only meaningful while that mode is open.
    this.relayHealthEl.hidden =
      !this.isOnline() || snap.status === "unconfigured";

    const ready = snap.status === "online";
    this.hostBtn.disabled = !ready;
    this.joinBtn.disabled = !ready;
    this.roomInput.disabled = !ready;

    if (this.isOnline() && !ready && !this.room?.isConnected()) {
      if (snap.status === "waking" || snap.status === "checking") {
        this.roomStatusEl.textContent =
          "Waiting for multiplayer server to wake up before you can create/join…";
      } else if (snap.status === "offline") {
        this.roomStatusEl.textContent =
          "Multiplayer server is offline. Keep this tab open — it will retry automatically.";
      }
    }
  }

  private syncChrome(): void {
    const vsAi = this.opponentSelect.value === "ai";
    const online = this.isOnline();
    this.taglineEl.textContent = vsAi
      ? "You vs a bot"
      : online
        ? "You vs a friend"
        : "Two players, one keyboard";
    this.difficultyWrap.style.display = vsAi ? "" : "none";
    this.roomPanel.hidden = !online;
    this.pingEl.hidden = !online;
    if (!online) {
      this.lastPingMs = null;
      this.pingEl.textContent = "Ping —";
    }
    // Re-apply health chip visibility now that Online panel may have opened.
    this.onRelayHealth(this.relayHealth.snapshot());
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

  private tipsButton(): string {
    if (this.opponentSelect.value !== "ai") return "";
    return `<button type="button" class="tips-link" data-tips>Tips</button>`;
  }

  private updateHelp(mode: GameMode): void {
    const tips = this.tipsButton();
    if (mode === "garbage") {
      this.helpEl.innerHTML = `
        <p class="help-lead">
          Big merges send a blocker. It replaces their next spawn.${tips}
        </p>
        <ul class="garbage-rules">
          <li>Merge a <strong>128</strong> → lasts <strong>3</strong> moves</li>
          <li>Merge a <strong>256</strong> → lasts <strong>4</strong> moves</li>
          <li>Merge a <strong>512</strong> → lasts <strong>5</strong> moves</li>
          <li>Merge a <strong>1024</strong> → lasts <strong>6</strong> moves</li>
          <li>Merge a <strong>2048+</strong> → lasts <strong>7</strong> moves</li>
        </ul>
      `;
    } else {
      this.helpEl.innerHTML = `
        <p class="help-lead">Same tiles on both boards. Space starts over.${tips}</p>
      `;
    }
  }

  private onCoachDone(): void {
    this.helpEl.hidden = false;
    this.updateHelp(this.match.state.config.mode);
    if (this.statusEl.classList.contains("win")) return;
    if (this.match.state.message) {
      this.statusEl.textContent = this.match.state.message;
      return;
    }
    if (this.match.state.status === "playing" && this.match.state.config.opponent === "ai") {
      this.statusEl.textContent = this.aiArmed ? "Race on — beat the AI!" : "Your move";
    }
  }

  private readConfig(seed?: number): MatchConfig {
    return {
      mode: this.modeSelect.value as GameMode,
      opponent: this.opponentSelect.value as Opponent,
      difficulty: this.difficultySelect.value as AiDifficulty,
      target: Number(this.targetSelect.value),
      seed,
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

  private ensureRoom(): WsRoom {
    if (this.room) return this.room;
    this.roomLogEl.textContent = "";
    this.room = new WsRoom({
      onStatus: (status, detail) => this.onRoomStatus(status, detail),
      onHello: (hello) => this.onRoomHello(hello),
      onRemoteMove: (dir) => void this.onRemoteMove(dir),
      onRestart: (hello) => this.onRoomRestart(hello),
      onRestartRequest: () => this.onRestartRequest(),
      onPing: (rtt) => this.onPing(rtt),
      onLog: (line) => this.appendRoomLog(line),
    });
    return this.room;
  }

  private appendRoomLog(line: string): void {
    const next = `${line}\n${this.roomLogEl.textContent ?? ""}`;
    this.roomLogEl.textContent = next.split("\n").slice(0, 24).join("\n");
  }

  private async copyRoomCode(): Promise<void> {
    const code = this.room?.getRoomCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.roomStatusEl.textContent = `Copied ${code} — paste it in the other browser.`;
    } catch {
      this.roomStatusEl.textContent = `Copy failed — type this code manually: ${code}`;
    }
  }

  private onRoomStatus(status: RoomStatus, detail?: string): void {
    this.leaveBtn.hidden = status === "idle";
    this.copyBtn.hidden = !(status === "hosting" || status === "connected");

    switch (status) {
      case "idle":
        this.onlineReady = false;
        this.roomStatusEl.textContent =
          "Create a room and share the code, or join a friend.";
        this.roomCodeEl.hidden = true;
        this.pingEl.hidden = true;
        break;
      case "hosting":
        this.onlineReady = false;
        this.roomStatusEl.textContent =
          "Waiting for opponent… keep this tab open, then Join from the other browser.";
        this.roomCodeEl.hidden = false;
        this.roomCodeEl.textContent = `Room code: ${detail}`;
        break;
      case "connecting":
        this.onlineReady = false;
        this.roomStatusEl.textContent = `Connecting to ${detail}…`;
        this.roomCodeEl.hidden = true;
        break;
      case "connected":
        this.roomStatusEl.textContent = `Connected · room ${detail}`;
        this.roomCodeEl.hidden = false;
        this.roomCodeEl.textContent = `Room code: ${detail}`;
        this.pingEl.hidden = false;
        if (this.room?.getRole() === "host" && !this.onlineHelloSent) {
          this.onlineHelloSent = true;
          const seed = this.match?.state.seed ?? randomSeed();
          this.room.sendHello({
            seed,
            mode: this.modeSelect.value as GameMode,
            target: Number(this.targetSelect.value),
          });
          this.onlineReady = true;
          if (!this.match.state.message) {
            this.statusEl.textContent = "Opponent joined — make a move!";
          }
          this.refreshBoardTitles();
        } else if (this.room?.getRole() === "guest") {
          this.onlineReady = true;
        }
        break;
      case "disconnected":
        this.onlineReady = false;
        this.roomStatusEl.textContent = detail || "Disconnected";
        this.statusEl.textContent = "Opponent disconnected.";
        this.aiGeneration += 1;
        break;
      case "error":
        this.onlineReady = false;
        this.roomStatusEl.textContent = `Error: ${detail || "connection failed"}`;
        break;
    }
  }

  private onRoomHello(hello: RoomHello): void {
    // Guest receives authoritative match config from host.
    this.modeSelect.value = hello.mode;
    this.targetSelect.value = String(hello.target);
    this.startSharedMatch(hello);
    this.onlineReady = true;
    this.statusEl.textContent = "Connected — make a move to start!";
    this.roomStatusEl.textContent = `Connected · room ${this.room?.getRoomCode()}`;
  }

  private onRoomRestart(hello: RoomHello): void {
    this.modeSelect.value = hello.mode;
    this.targetSelect.value = String(hello.target);
    this.startSharedMatch(hello);
    this.onlineReady = true;
    this.statusEl.textContent = "Match reset — go!";
  }

  private onRestartRequest(): void {
    if (this.room?.getRole() === "host") {
      this.hostRestartMatch();
    }
  }

  private onPing(rttMs: number): void {
    this.lastPingMs = rttMs;
    this.pingEl.hidden = false;
    this.pingEl.textContent = `Ping ${rttMs} ms`;
    this.pingEl.classList.toggle("ping-good", rttMs < 80);
    this.pingEl.classList.toggle("ping-ok", rttMs >= 80 && rttMs < 180);
    this.pingEl.classList.toggle("ping-bad", rttMs >= 180);
  }

  private async hostRoom(): Promise<void> {
    if (!this.relayHealth.isOnline()) {
      this.roomStatusEl.textContent =
        "Multiplayer server is still waking up — wait until it shows ready.";
      return;
    }
    if (!this.isOnline()) {
      this.opponentSelect.value = "online";
      this.syncChrome();
    }
    this.onlineHelloSent = false;
    const room = this.ensureRoom();
    try {
      const code = await room.host();
      this.startSharedMatch({
        seed: randomSeed(),
        mode: this.modeSelect.value as GameMode,
        target: Number(this.targetSelect.value),
      });
      this.statusEl.textContent = `Room ${code} ready — share the code!`;
      this.releaseUiFocus();
    } catch {
      /* status already reported */
    }
  }

  private async joinRoom(): Promise<void> {
    if (!this.relayHealth.isOnline()) {
      this.roomStatusEl.textContent =
        "Multiplayer server is still waking up — wait until it shows ready.";
      return;
    }
    if (!this.isOnline()) {
      this.opponentSelect.value = "online";
      this.syncChrome();
    }
    const room = this.ensureRoom();
    try {
      await room.join(this.roomInput.value);
      this.releaseUiFocus();
    } catch {
      /* status already reported */
    }
  }

  private leaveRoom(): void {
    this.room?.disconnect();
    this.room = null;
    this.onlineReady = false;
    this.onlineHelloSent = false;
    this.newGame();
  }

  private startSharedMatch(hello: RoomHello): void {
    this.aiGeneration += 1;
    this.aiArmed = false;
    this.resetTimerDisplay();
    this.match = createMatch({
      mode: hello.mode,
      opponent: "online",
      difficulty: "normal",
      target: hello.target,
      seed: hello.seed,
    });
    this.refreshAllBoards();
    this.refreshBoardTitles();
    this.statusEl.classList.remove("win");
    this.seedEl.textContent = `Seed ${this.match.state.seed} · room ${this.room?.getRoomCode() ?? "—"}`;
    this.updateHelp(hello.mode);
  }

  private hostRestartMatch(): void {
    if (!this.room || this.room.getRole() !== "host") return;
    const hello: RoomHello = {
      seed: randomSeed(),
      mode: this.modeSelect.value as GameMode,
      target: Number(this.targetSelect.value),
    };
    this.startSharedMatch(hello);
    if (this.room.isConnected()) {
      this.room.sendRestart(hello);
      this.onlineReady = true;
      this.statusEl.textContent = "Match reset — go!";
    }
  }

  private onNewGameClick(): void {
    if (this.isOnline()) {
      if (this.room?.getRole() === "host") {
        this.hostRestartMatch();
      } else if (this.room?.isConnected()) {
        this.room.requestRestart();
        this.statusEl.textContent = "Restart requested…";
      } else {
        this.statusEl.textContent = "Create or join a room first.";
      }
      return;
    }
    this.newGame();
  }

  private refreshBoardTitles(): void {
    const { config } = this.match.state;
    if (config.opponent === "online") {
      const role = this.room?.getRole();
      this.views[0].setTitle(
        "You",
        role === "guest"
          ? "WASD / Arrows · Space requests reset"
          : "WASD / Arrows · Space resets",
      );
      this.views[1].setTitle(
        "Opponent",
        this.lastPingMs !== null ? `Online · ${this.lastPingMs} ms` : "Online",
      );
      return;
    }

    const vsAi = config.opponent === "ai";
    this.views[0].setTitle(
      playerLabel(0, config.opponent),
      vsAi ? "WASD or Arrow keys · Space resets" : "WASD · Space resets",
    );
    this.views[1].setTitle(
      playerLabel(1, config.opponent),
      vsAi ? `${config.difficulty} AI` : "Arrow keys · Space resets",
    );
  }

  private refreshAllBoards(): void {
    if (this.isOnline()) {
      const local = this.localSeat();
      const remote = this.remoteSeat();
      this.views[0]!.renderStatic(
        this.match.state.players[local],
        this.pendingFor(local),
      );
      this.views[1]!.renderStatic(
        this.match.state.players[remote],
        this.pendingFor(remote),
      );
      this.views[0]!.setOverlay(null);
      this.views[1]!.setOverlay(null);
      this.refreshOverlays();
      return;
    }

    for (let i = 0; i < 2; i++) {
      const ps = this.match.state.players[i as PlayerId];
      this.views[i]!.renderStatic(ps, this.pendingFor(i as PlayerId));
      this.views[i]!.setOverlay(null);
    }
    this.refreshOverlays();
  }

  newGame(): void {
    this.aiGeneration += 1;
    this.aiArmed = false;
    this.resetTimerDisplay();

    if (this.isOnline()) {
      if (this.coach.step === "race") this.coach.complete(true);
      else this.coach.hide();
      this.helpEl.hidden = false;
      // Stay idle until a room hello / host seed exists.
      this.match = createMatch(this.readConfig(randomSeed()));
      this.refreshAllBoards();
      this.refreshBoardTitles();
      this.statusEl.textContent = this.room?.isConnected()
        ? "Connected — make a move!"
        : "Create or join a room to play online.";
      this.statusEl.classList.remove("win");
      this.seedEl.textContent = this.room?.getRoomCode()
        ? `Room ${this.room.getRoomCode()}`
        : "Online lobby";
      this.updateHelp(this.match.state.config.mode);
      this.releaseUiFocus();
      return;
    }

    if (this.coach.step === "race") this.coach.complete(true);

    this.match = createMatch(this.readConfig());
    const { config } = this.match.state;
    const vsAi = config.opponent === "ai";

    this.refreshBoardTitles();
    this.refreshAllBoards();

    this.statusEl.classList.remove("win");
    this.seedEl.textContent = `Seed ${this.match.state.seed} · fair shared RNG`;
    this.releaseUiFocus();

    if (vsAi && this.coach.shouldOffer()) {
      this.statusEl.textContent = "";
      this.helpEl.hidden = true;
      this.coach.start(config.target);
      return;
    }

    this.coach.hide();
    this.helpEl.hidden = false;
    this.statusEl.textContent = vsAi
      ? "Your move"
      : "Go! Player 1: WASD · Player 2: Arrows";
    this.updateHelp(config.mode);
  }

  private onResize(): void {
    this.refreshAllBoards();
  }

  private bindSwipe(arena: Element): void {
    let start: { x: number; y: number; id: number } | null = null;

    arena.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent)) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("button, a, input, select")) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      if (target instanceof HTMLElement) target.setPointerCapture?.(event.pointerId);
    });

    arena.addEventListener("pointerup", (event) => {
      if (!(event instanceof PointerEvent) || !start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const origin = start;
      start = null;
      if (Math.hypot(dx, dy) < 30) return;
      const dir: Direction =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0
            ? RIGHT
            : LEFT
          : dy > 0
            ? DOWN
            : UP;
      this.onSwipe(dir, event.target, origin);
    });

    arena.addEventListener("pointercancel", () => {
      start = null;
    });
  }

  private onSwipe(
    dir: Direction,
    target: EventTarget | null,
    origin: { x: number; y: number },
  ): void {
    const { opponent } = this.match.state.config;
    let player: PlayerId = 0;
    if (opponent === "online") {
      if (!this.onlineReady || !this.room?.isConnected()) return;
      player = this.localSeat();
    } else if (opponent === "local") {
      const hit =
        (target instanceof Element ? target.closest(".player-panel") : null) ??
        document.elementFromPoint(origin.x, origin.y)?.closest(".player-panel");
      player = hit === this.views[1].root ? 1 : 0;
    }
    void this.tryMove(player, dir, { broadcast: true });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    const onFormControl =
      tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

    if (onFormControl && this.isGameKey(e)) {
      e.preventDefault();
      this.releaseUiFocus();
    } else if (onFormControl) {
      return;
    }

    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (this.coach.step === "slide") return;
      this.onNewGameClick();
      return;
    }

    const { opponent } = this.match.state.config;
    let player: PlayerId | null = null;
    let dir: Direction | undefined;

    if (opponent === "online") {
      if (!this.onlineReady || !this.room?.isConnected()) return;
      dir = WASD[e.key.toLowerCase()] ?? ARROWS[e.key];
      if (dir !== undefined) player = this.localSeat();
    } else if (opponent === "ai") {
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
    void this.tryMove(player, dir, { broadcast: true });
  }

  private async onRemoteMove(dir: Direction): Promise<void> {
    if (!this.isOnline() || !this.onlineReady) return;
    await this.tryMove(this.remoteSeat(), dir, { broadcast: false });
  }

  private async tryMove(
    player: PlayerId,
    dir: Direction,
    opts: { broadcast: boolean },
  ): Promise<boolean> {
    if (this.match.state.status !== "playing") return false;
    if (!this.match.state.players[player].alive) return false;

    const result = applyPlayerMove(this.match, player, dir);
    if (!result) return false;

    this.startTimer();

    const vsAi = this.match.state.config.opponent === "ai";
    if (player === 0 && vsAi && !this.aiArmed) {
      this.aiArmed = true;
      if (this.coach.step === "off") {
        this.statusEl.textContent = "Race on — beat the AI!";
      }
      this.scheduleAi();
    }
    if (vsAi && player === 0) this.coach.noteMove();

    if (
      opts.broadcast &&
      this.isOnline() &&
      this.room?.isConnected() &&
      player === this.localSeat()
    ) {
      this.room.sendMove(dir);
    }

    const after = this.match.state.players[player];
    const view = this.viewForSeat(player);
    await view.playMove(after, result, this.pendingFor(player));

    const opp = (player === 0 ? 1 : 0) as PlayerId;
    this.viewForSeat(opp).syncScores(
      this.match.state.players[opp],
      this.pendingFor(opp),
    );

    this.refreshOverlays();
    this.updateStatus();
    this.refreshBoardTitles();

    if (this.match.state.winner !== null) {
      this.stopTimer(true);
    }
    return true;
  }

  private refreshOverlays(): void {
    const { state } = this.match;
    const seats: PlayerId[] = this.isOnline()
      ? [this.localSeat(), this.remoteSeat()]
      : [0, 1];

    for (let viewIdx = 0; viewIdx < 2; viewIdx++) {
      const seat = seats[viewIdx]!;
      const ps = state.players[seat];
      const view = this.views[viewIdx]!;
      if (state.status === "finished") {
        if (state.winner === "draw") {
          view.setOverlay("Draw");
        } else if (state.winner === seat) {
          view.setOverlay("Winner!");
        } else {
          view.setOverlay(ps.alive ? "—" : "Game over");
        }
      } else if (!ps.alive) {
        view.setOverlay("Game over");
      } else {
        view.setOverlay(null);
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
        if (state.config.opponent === "online") {
          const youWon = state.winner === this.localSeat();
          this.statusEl.textContent = youWon ? "You win!" : "Opponent wins!";
        } else {
          const name = playerLabel(state.winner, state.config.opponent);
          this.statusEl.textContent = state.message || `${name} wins!`;
        }
      }
      return;
    }

    this.statusEl.classList.remove("win");

    // Keep a stable survival / info line — never blank it on later moves.
    if (state.message) {
      if (this.statusEl.textContent !== state.message) {
        this.statusEl.textContent = state.message;
      }
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

    await this.tryMove(1, move, { broadcast: false });

    if (gen === this.aiGeneration && this.match.state.status === "playing") {
      this.scheduleAi();
    }
  }
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  new GameApp(app);
}
