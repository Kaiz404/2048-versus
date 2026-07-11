import type { Direction, GameMode } from "../game/types";
import {
  generateRoomCode,
  normalizeRoomCode,
  parseMessage,
  type NetMessage,
} from "./protocol";

export type RoomRole = "host" | "guest";
export type RoomStatus =
  | "idle"
  | "hosting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface RoomHello {
  seed: number;
  mode: GameMode;
  target: number;
}

export interface WsRoomHandlers {
  onStatus: (status: RoomStatus, detail?: string) => void;
  onHello: (hello: RoomHello) => void;
  onRemoteMove: (dir: Direction) => void;
  onRestart: (hello: RoomHello) => void;
  onRestartRequest: () => void;
  onPing: (rttMs: number) => void;
  onLog?: (line: string) => void;
}

type SysMessage =
  | {
      type: "sys";
      event: "welcome";
      room: string;
      peerId: number;
      seat: "host" | "guest";
      count: number;
    }
  | { type: "sys"; event: "roster"; count: number }
  | { type: "sys"; event: "peer-left" }
  | { type: "sys"; event: "error"; message: string }
  | { type: "relay"; from: number; payload: string };

function defaultRelayUrl(): string {
  const fromEnv = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/$/, "");
  // Local relay started by `npm run relay`
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Prefer same hostname so phones on LAN can join via the machine's IP.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "ws://127.0.0.1:8787";
  }
  return `${proto}//${location.hostname}:8787`;
}

/**
 * Online room over a tiny WebSocket relay (see server/relay.mjs).
 * Same app-facing API as the old PeerJS room, but without ICE/NAT pain.
 */
export class WsRoom {
  private ws: WebSocket | null = null;
  private role: RoomRole | null = null;
  private roomCode: string | null = null;
  private moveSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private peerCount = 0;
  private handlers: WsRoomHandlers;
  private relayBase: string;

  constructor(handlers: WsRoomHandlers, relayUrl?: string) {
    this.handlers = handlers;
    this.relayBase = (relayUrl ?? defaultRelayUrl()).replace(/\/$/, "");
  }

  getRole(): RoomRole | null {
    return this.role;
  }

  getRoomCode(): string | null {
    return this.roomCode;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.peerCount >= 2;
  }

  async host(): Promise<string> {
    this.teardown();
    this.destroyed = false;
    this.role = "host";
    this.roomCode = generateRoomCode();
    this.handlers.onStatus("hosting", this.roomCode);
    this.log(`Hosting room ${this.roomCode} via ${this.relayBase}`);
    await this.openSocket(this.roomCode);
    return this.roomCode;
  }

  async join(rawCode: string): Promise<void> {
    const code = normalizeRoomCode(rawCode);
    if (code.length !== 6) {
      this.handlers.onStatus("error", "Room code must be 6 characters");
      return;
    }
    this.teardown();
    this.destroyed = false;
    this.role = "guest";
    this.roomCode = code;
    this.handlers.onStatus("connecting", code);
    this.log(`Joining room ${code} via ${this.relayBase}`);
    await this.openSocket(code);
  }

  sendHello(hello: RoomHello): void {
    this.sendGame({ type: "hello", ...hello });
  }

  sendMove(dir: Direction): void {
    this.moveSeq += 1;
    this.sendGame({ type: "move", dir, seq: this.moveSeq });
  }

  sendRestart(hello: RoomHello): void {
    this.sendGame({ type: "restart", ...hello });
  }

  requestRestart(): void {
    this.sendGame({ type: "restart-request" });
  }

  disconnect(): void {
    this.destroyed = true;
    this.teardown();
    this.role = null;
    this.roomCode = null;
    this.handlers.onStatus("idle");
  }

  private openSocket(room: string): Promise<void> {
    const intent = this.role === "host" ? "host" : "join";
    const url = `${this.relayBase}/?room=${encodeURIComponent(room)}&intent=${intent}`;
    this.log(`Opening ${url}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log("Timed out connecting to relay");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("Timed out reaching the relay server. Is `npm run relay` running?"));
        this.handlers.onStatus(
          "error",
          "Cannot reach relay — run `npm run relay` in another terminal",
        );
      }, 8000);

      ws.onopen = () => {
        this.log("Relay socket open — waiting for welcome");
      };

      ws.onmessage = (ev) => {
        let msg: SysMessage;
        try {
          msg = JSON.parse(String(ev.data)) as SysMessage;
        } catch {
          this.log("Bad relay frame");
          return;
        }

        if (msg.type === "sys" && msg.event === "welcome") {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            this.role = msg.seat;
            this.peerCount = msg.count;
            this.log(`Welcome as ${msg.seat} (peers=${msg.count})`);
            if (msg.count >= 2) {
              this.handlers.onStatus("connected", this.roomCode ?? undefined);
              this.startPing();
            } else {
              this.handlers.onStatus("hosting", this.roomCode ?? undefined);
            }
            resolve();
          }
          return;
        }

        this.handleServerMessage(msg);
      };

      ws.onerror = () => {
        this.log("Relay socket error");
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("Relay connection failed"));
          this.handlers.onStatus(
            "error",
            "Relay connection failed — start it with `npm run relay`",
          );
        }
      };

      ws.onclose = () => {
        this.stopPing();
        if (this.destroyed) return;
        this.log("Relay socket closed");
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("Relay closed before welcome"));
        } else {
          this.peerCount = 0;
          this.handlers.onStatus("disconnected", "Disconnected from relay");
        }
      };
    });
  }

  private handleServerMessage(msg: SysMessage): void {
    if (msg.type === "sys") {
      switch (msg.event) {
        case "roster":
          this.peerCount = msg.count;
          this.log(`Roster: ${msg.count} peer(s)`);
          if (msg.count >= 2) {
            this.handlers.onStatus("connected", this.roomCode ?? undefined);
            this.startPing();
          }
          break;
        case "peer-left":
          this.peerCount = Math.max(0, this.peerCount - 1);
          this.stopPing();
          this.handlers.onStatus("disconnected", "Opponent left");
          break;
        case "error":
          this.handlers.onStatus("error", msg.message);
          break;
        default:
          break;
      }
      return;
    }

    if (msg.type === "relay") {
      const game = parseMessage(msg.payload);
      if (!game) {
        this.log("Ignored bad game payload");
        return;
      }
      this.handleGameMessage(game);
    }
  }

  private handleGameMessage(msg: NetMessage): void {
    switch (msg.type) {
      case "hello":
        this.handlers.onHello({
          seed: msg.seed,
          mode: msg.mode,
          target: msg.target,
        });
        break;
      case "move":
        this.handlers.onRemoteMove(msg.dir);
        break;
      case "restart":
        this.handlers.onRestart({
          seed: msg.seed,
          mode: msg.mode,
          target: msg.target,
        });
        break;
      case "restart-request":
        this.handlers.onRestartRequest();
        break;
      case "ping":
        this.sendGame({ type: "pong", t: msg.t });
        break;
      case "pong": {
        const rtt = Math.max(0, Math.round(performance.now() - msg.t));
        this.handlers.onPing(rtt);
        break;
      }
    }
  }

  private sendGame(msg: NetMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Send skipped: ${msg.type}`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendGame({ type: "ping", t: performance.now() });
    }, 1000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private log(line: string): void {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    // Keep the UI log quiet; only surface important lines.
    const important =
      /error|fail|timeout|welcome|roster|connected|disconnected|hosting|joining|opening/i.test(
        line,
      );
    if (important) this.handlers.onLog?.(stamped);
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG === "1") {
      console.info("[2048-versus]", stamped);
    }
  }

  private teardown(): void {
    this.stopPing();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.peerCount = 0;
    this.moveSeq = 0;
  }
}
