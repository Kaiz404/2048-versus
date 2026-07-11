import type { Direction, GameMode } from "../game/types";

/** Wire protocol for online 1v1 (JSON over WebRTC data channel). */
export type NetMessage =
  | {
      type: "hello";
      seed: number;
      mode: GameMode;
      target: number;
    }
  | {
      type: "move";
      dir: Direction;
      seq: number;
    }
  | {
      type: "restart";
      seed: number;
      mode: GameMode;
      target: number;
    }
  | { type: "restart-request" }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

export const ROOM_CODE_LEN = 6;
/** Lowercase-friendly peer ids are more reliable on the public PeerServer. */
const ROOM_PREFIX = "v2048";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  let out = "";
  const bytes = new Uint8Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LEN);
}

/** PeerJS id derived from the human room code. */
export function toPeerId(code: string): string {
  return `${ROOM_PREFIX}${normalizeRoomCode(code).toLowerCase()}`;
}

export function parseMessage(data: unknown): NetMessage | null {
  try {
    let value: unknown = data;
    if (typeof data === "string") {
      value = JSON.parse(data);
    } else if (data instanceof ArrayBuffer) {
      value = JSON.parse(new TextDecoder().decode(data));
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      value = JSON.parse(
        new TextDecoder().decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)),
      );
    }

    if (!value || typeof value !== "object") return null;
    const msg = value as NetMessage;
    if (typeof (msg as { type?: string }).type !== "string") return null;
    return msg;
  } catch {
    return null;
  }
}
