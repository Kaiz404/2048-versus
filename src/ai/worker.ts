/**
 * @vite-ignore — bundled as a module worker.
 */
import { chooseAiMove, type AiDifficulty } from "../game/ai";
import type { Direction } from "../game/types";

export interface AiRequest {
  id: number;
  cells: number[];
  difficulty: AiDifficulty;
}

export interface AiResponse {
  id: number;
  move: Direction | null;
}

self.onmessage = (ev: MessageEvent<AiRequest>) => {
  const { id, cells, difficulty } = ev.data;
  const move = chooseAiMove(cells, difficulty);
  const response: AiResponse = { id, move };
  self.postMessage(response);
};
