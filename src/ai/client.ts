import type { AiDifficulty } from "../game/ai";
import type { Direction } from "../game/types";
import type { AiRequest, AiResponse } from "./worker";

export class AiClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (move: Direction | null) => void>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<AiResponse>) => {
      const { id, move } = ev.data;
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(move);
      }
    };
    return this.worker;
  }

  request(cells: number[], difficulty: AiDifficulty): Promise<Direction | null> {
    const id = this.nextId++;
    const worker = this.ensure();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const msg: AiRequest = { id, cells, difficulty };
      worker.postMessage(msg);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
