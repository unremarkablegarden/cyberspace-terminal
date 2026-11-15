import {
  getMoves, sameSquare, squareName,
  type ChessState, type Kind, type Move, type Square,
} from './rules'

const ENGINE_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`
const PIECE_LETTER: Record<Kind, string> = {
  king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p',
}
const PROMOTION_KIND: Record<string, Kind> = {
  q: 'queen', r: 'rook', b: 'bishop', n: 'knight',
}

/** Stockfish runs in its own worker, so search never stalls the terminal. */
export class StockfishEngine {
  private worker: Worker | null
  private ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private pending: ((move: string | null) => void) | null = null

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.worker = new Worker(ENGINE_URL)
    this.worker.onmessage = event => this.receive(String(event.data))
    this.worker.onerror = event => this.fail(new Error(event.message || 'Stockfish failed to load'))
    this.worker.postMessage('uci')
  }

  async chooseMove(state: ChessState): Promise<Move | null> {
    await this.ready
    const bestMove = await new Promise<string | null>(resolve => {
      this.pending = resolve
      this.worker?.postMessage(`position fen ${toFen(state)}`)
      this.worker?.postMessage('go movetime 650')
    })
    if (!bestMove) {
      if (!this.worker) throw new Error('Stockfish worker stopped')
      return null
    }

    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(bestMove)
    if (!match) throw new Error(`Stockfish returned an invalid move: ${bestMove}`)
    const from = parseSquare(match[1]!)
    const to = parseSquare(match[2]!)
    const promotion = match[3] ? PROMOTION_KIND[match[3]] : undefined
    const legalMoves = getMoves(state, from)
    return legalMoves.find(move =>
      sameSquare(move.to, to) && move.promotion === promotion,
    ) ?? (promotion
      ? legalMoves.find(move => sameSquare(move.to, to) && move.promotion === 'queen')
      : null) ?? null
  }

  dispose(): void {
    this.pending?.(null)
    this.pending = null
    this.worker?.terminate()
    this.worker = null
    this.readyReject(new Error('Stockfish worker stopped'))
  }

  private receive(line: string): void {
    if (line === 'uciok') {
      this.worker?.postMessage('setoption name Skill Level value 5')
      this.worker?.postMessage('isready')
      return
    }
    if (line === 'readyok') {
      this.readyResolve()
      return
    }
    if (line.startsWith('bestmove ')) {
      const move = line.split(/\s+/)[1]
      this.pending?.(move && move !== '(none)' ? move : null)
      this.pending = null
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    this.pending?.(null)
    this.pending = null
    this.worker?.terminate()
    this.worker = null
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
