const STORAGE_KEY = "2048-versus-coach";

export type CoachStep = "off" | "slide" | "race";

function readDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private browsing */
  }
}

/**
 * Two beats, shown once:
 *  1. A tile slides into its match, and the arrow keys light up.
 *  2. You and the AI sit on either side of the target tile.
 * The pictures carry it. The captions stay to one line.
 */
export class Coach {
  step: CoachStep = "off";
  private done = readDone();
  private root: HTMLElement;
  private slideEl: HTMLElement;
  private raceEl: HTMLElement;
  private captionEl: HTMLElement;
  private targetEl: HTMLElement;
  private panels: [HTMLElement, HTMLElement];
  private target = 2048;
  private raceAt = 0;
  private raceTimer = 0;
  private onDone: () => void;

  constructor(
    mount: Element,
    panels: [HTMLElement, HTMLElement],
    onDone: () => void,
  ) {
    this.onDone = onDone;
    this.panels = panels;
    this.root = document.createElement("div");
    this.root.className = "coach";
    this.root.hidden = true;
    this.root.setAttribute("role", "group");
    this.root.innerHTML = `
      <div class="coach-demo" data-coach-slide>
        <div class="coach-merge" aria-hidden="true">
          <span class="coach-tile coach-tile-a">2</span>
          <span class="coach-tile coach-tile-b">2</span>
          <span class="coach-tile coach-tile-sum">4</span>
        </div>
        <div class="coach-keys" aria-hidden="true">
          <kbd class="k k-up">↑</kbd>
          <kbd class="k k-left">←</kbd>
          <kbd class="k k-down">↓</kbd>
          <kbd class="k k-right">→</kbd>
        </div>
      </div>
      <div class="coach-demo" data-coach-race hidden>
        <div class="coach-race" aria-hidden="true">
          <span class="coach-side">You</span>
          <span class="coach-flag" data-coach-target>2048</span>
          <span class="coach-side">AI</span>
        </div>
      </div>
      <p class="coach-caption" data-coach-caption>Slide</p>
      <button type="button" class="coach-skip" data-coach-skip>Skip</button>
    `;
    mount.append(this.root);
    this.slideEl = this.root.querySelector("[data-coach-slide]")!;
    this.raceEl = this.root.querySelector("[data-coach-race]")!;
    this.captionEl = this.root.querySelector("[data-coach-caption]")!;
    this.targetEl = this.root.querySelector("[data-coach-target]")!;
    this.root.querySelector("[data-coach-skip]")!.addEventListener("click", () => {
      this.complete();
    });
  }

  /** True until the player finishes or skips the tour. */
  shouldOffer(): boolean {
    return !this.done;
  }

  start(target: number, force = false): void {
    if (!force && this.done) return;
    this.target = target;
    this.showSlide();
  }

  /** Hide without remembering. Used when leaving versus-bot. */
  hide(): void {
    this.clearTimer();
    this.step = "off";
    this.root.hidden = true;
    this.clearPanels();
  }

  complete(silent = false): void {
    this.done = true;
    writeDone();
    this.hide();
    if (!silent) this.onDone();
  }

  noteMove(): void {
    if (this.step === "slide") {
      this.showRace();
      return;
    }
    if (this.step === "race" && performance.now() - this.raceAt > 900) {
      this.complete();
    }
  }

  private showSlide(): void {
    this.clearTimer();
    this.step = "slide";
    this.slideEl.hidden = false;
    this.raceEl.hidden = true;
    this.captionEl.textContent = "Slide";
    this.root.setAttribute(
      "aria-label",
      "Slide the tiles. Matching numbers merge.",
    );
    this.root.hidden = false;
    this.paintPanels("slide");
  }

  private showRace(): void {
    this.clearTimer();
    this.step = "race";
    this.raceAt = performance.now();
    this.targetEl.textContent = String(this.target);
    this.slideEl.hidden = true;
    this.raceEl.hidden = false;
    this.captionEl.textContent = `First to ${this.target}`;
    this.root.setAttribute(
      "aria-label",
      `You and the AI start the same. First to ${this.target} wins.`,
    );
    this.root.hidden = false;
    this.paintPanels("race");
    this.raceTimer = window.setTimeout(() => this.complete(), 3600);
  }

  private paintPanels(step: "slide" | "race"): void {
    const [you, bot] = this.panels;
    you.classList.toggle("coach-live", step === "slide");
    bot.classList.toggle("coach-dim", step === "slide");
    you.classList.toggle("coach-focus", step === "race");
    bot.classList.toggle("coach-focus", step === "race");
  }

  private clearPanels(): void {
    for (const panel of this.panels) {
      panel.classList.remove("coach-live", "coach-dim", "coach-focus");
    }
  }

  private clearTimer(): void {
    if (this.raceTimer) {
      window.clearTimeout(this.raceTimer);
      this.raceTimer = 0;
    }
  }
}
