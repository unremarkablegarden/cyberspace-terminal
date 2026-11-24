// Machine search for chess, in a dedicated worker: js-chess-engine searches synchronously, and level 5 takes up to a second per move on a laptop.
// The main thread posts a FEN and gets the engine's move back as UCI text (`e7e8`); the engine always promotes to a queen.

import { ai } from 'js-chess-engine'

export type EngineAsk = { id: number; fen: string; level: number }
export type EngineAnswer = { id: number; move?: string | null; error?: string }

self.onmessage = (e: MessageEvent<EngineAsk>) => {
  const { id, fen, level } = e.data
  try {
    // 30 centipawns: picks among near-equal moves so repeated games differ.
    const { move } = ai(fen, { level, play: false, randomness: 30 })
    const [from, to] = Object.entries(move)[0] ?? []
    self.postMessage({ id, move: from && to ? `${from}${to}`.toLowerCase() : null } satisfies EngineAnswer)
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies EngineAnswer)
  }
}
