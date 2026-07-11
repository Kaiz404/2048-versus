/**
 * HTTP health checks for the online WebSocket relay.
 * Used to wake Render free-tier services on page load before the user
 * opens Online mode (cold starts can take 30–60s).
 */

export type RelayHealthStatus =
  | "unconfigured"
  | "checking"
  | "waking"
  | "online"
  | "offline";

export interface RelayHealthSnapshot {
  status: RelayHealthStatus;
  /** Wall-clock ms spent trying since start (useful while waking). */
  elapsedMs: number;
  /** Last successful check latency, if any. */
  lastLatencyMs: number | null;
  detail: string;
}

const WAKE_POLL_MS = 3000;
const KEEP_ALIVE_MS = 4 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 12_000;
const MAX_WAKE_MS = 90_000;

/** Resolve the WebSocket relay base (no trailing slash). */
export function resolveRelayWsUrl(): string | null {
  const fromEnv = (import.meta.env.VITE_RELAY_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ) {
    return "ws://127.0.0.1:8787";
  }
  return null;
}

/** HTTP(S) origin used for health / wake pings. */
export function resolveRelayHttpUrl(): string | null {
  const ws = resolveRelayWsUrl();
  if (!ws) return null;
  if (ws.startsWith("wss://")) return `https://${ws.slice("wss://".length)}`;
  if (ws.startsWith("ws://")) return `http://${ws.slice("ws://".length)}`;
  return null;
}

async function pingOnce(httpBase: string): Promise<{ ok: boolean; latencyMs: number }> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(`${httpBase}/`, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    const ok = res.ok && /relay OK/i.test(text);
    return { ok, latencyMs };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Starts warming the relay immediately and keeps a light heartbeat while the
 * tab stays open so free-tier hosts are less likely to sleep mid-session.
 */
export class RelayHealthMonitor {
  private status: RelayHealthStatus = "checking";
  private startedAt = 0;
  private lastLatencyMs: number | null = null;
  private detail = "Checking multiplayer server…";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private listeners = new Set<(snap: RelayHealthSnapshot) => void>();
  private httpBase: string | null;

  constructor() {
    this.httpBase = resolveRelayHttpUrl();
    if (!this.httpBase) {
      this.status = "unconfigured";
      this.detail = "Online relay URL is not configured for this build.";
    }
  }

  subscribe(listener: (snap: RelayHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): RelayHealthSnapshot {
    return {
      status: this.status,
      elapsedMs: this.startedAt ? Math.max(0, Date.now() - this.startedAt) : 0,
      lastLatencyMs: this.lastLatencyMs,
      detail: this.detail,
    };
  }

  /** Fire-and-forget: begin wake + health loop. */
  start(): void {
    if (this.stopped) return;
    if (!this.httpBase) {
      this.emit();
      return;
    }
    this.startedAt = Date.now();
    this.setStatus("checking", "Waking multiplayer server…");
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isOnline(): boolean {
    return this.status === "online";
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    if (this.stopped || !this.httpBase) return;

    const { ok, latencyMs } = await pingOnce(this.httpBase);
    if (this.stopped) return;

    if (ok) {
      this.lastLatencyMs = latencyMs;
      this.setStatus("online", `Multiplayer server ready (${latencyMs} ms)`);
      this.schedule(KEEP_ALIVE_MS);
      return;
    }

    const elapsed = Date.now() - this.startedAt;
    if (elapsed < MAX_WAKE_MS) {
      const secs = Math.round(elapsed / 1000);
      this.setStatus(
        "waking",
        `Multiplayer server waking up… ${secs}s (free hosts can take ~30–60s)`,
      );
      this.schedule(WAKE_POLL_MS);
      return;
    }

    this.setStatus(
      "offline",
      "Multiplayer server unreachable. Retrying periodically…",
    );
    // Keep trying slowly — Render may still come up later.
    this.schedule(KEEP_ALIVE_MS);
  }

  private setStatus(status: RelayHealthStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}
