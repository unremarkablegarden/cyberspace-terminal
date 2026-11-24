import {
  getMoves, sameSquare, squareName,
  type ChessState, type Kind, type Move, type Square,
} from './rules'
import type { EngineAnswer, EngineAsk } from './engine.worker'

const PIECE_LETTER: Record<Kind, string> = {
  king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p',
}

/** The machine player. Search runs in chess/engine.worker.ts so it never stalls the terminal. */
export class ChessEngine {
  private worker: Worker | null = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, (answer: EngineAnswer) => void>()

  constructor() {
    this.worker!.onmessage = (e: MessageEvent<EngineAnswer>) => {
      this.pending.get(e.data.id)?.(e.data)
      this.pending.delete(e.data.id)
    }
    this.worker!.onerror = e => this.settleAll(e.message || 'engine failed to load')
  }

  /** `level` is the js-chess-engine level, 1 to 5. Level 5 takes up to a second per move on a laptop. */
  async chooseMove(state: ChessState, level: number): Promise<Move | null> {
    if (!this.worker) throw new Error('engine stopped')
    const id = this.nextId++
    const answer = await new Promise<EngineAnswer>(resolve => {
      this.pending.set(id, resolve)
      this.worker!.postMessage({ id, fen: toFen(state), level } satisfies EngineAsk)
    })
    if (answer.error) throw new Error(answer.error)
    if (!answer.move) return null

    const match = /^([a-h][1-8])([a-h][1-8])$/.exec(answer.move)
    if (!match) throw new Error(`engine returned an invalid move: ${answer.move}`)
    const from = parseSquare(match[1]!)
    const to = parseSquare(match[2]!)
    // A promotion appears once per piece kind in getMoves; the engine always promotes to a queen.
    const candidates = getMoves(state, from).filter(move => sameSquare(move.to, to))
    return candidates.find(move => !move.promotion || move.promotion === 'queen') ?? null
  }

  dispose(): void {
    this.settleAll('engine stopped')
    this.worker?.terminate()
    this.worker = null
  }

  private settleAll(error: string): void {
    for (const [id, resolve] of this.pending) resolve({ id, error })
    this.pending.clear()
  }
}

function toFen(state: ChessState): string {
  const ranks = state.board.map(row => {
    let empty = 0
    let rank = ''
    for (const piece of row) {
      if (!piece) {
        empty++
        continue
      }
      if (empty) rank += empty
      empty = 0
      const letter = PIECE_LETTER[piece.kind]
      rank += piece.color === 'white' ? letter.toUpperCase() : letter
    }
    if (empty) rank += empty
    return rank
  }).join('/')
  const { castling } = state
  const rights = [
    castling.whiteKing && 'K', castling.whiteQueen && 'Q',
    castling.blackKing && 'k', castling.blackQueen && 'q',
  ].filter(Boolean).join('') || '-'
  const enPassant = state.enPassant ? squareName(state.enPassant) : '-'
  return `${ranks} ${state.turn === 'white' ? 'w' : 'b'} ${rights} ${enPassant} ${state.halfmove} ${state.fullmove}`
}

function parseSquare(value: string): Square {
  return { row: 8 - Number(value[1]), col: value.charCodeAt(0) - 97 }
}
