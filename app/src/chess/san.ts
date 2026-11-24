// Standard algebraic notation (SAN) for the move list, and replay of an online game sent as UCI moves.

import {
  applyMove, checkmate, getAllMoves, getMoves, getPiece, isCheck, newChessState, sameSquare, squareName,
  type ChessState, type Kind, type Move, type Square,
} from './rules'

const LETTER: Record<Kind, string> = { pawn: '', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' }
const PROMOTION: Record<string, Kind> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }

/** `move` in SAN, played from `state`: Nf3, exd5, O-O, e8=Q+, Qxf7#. */
export function san(state: ChessState, move: Move): string {
  const piece = getPiece(state, move.from)
  const after = applyMove(state, move)
  const suffix = checkmate(after) ? '#' : isCheck(after, after.turn) ? '+' : ''
  if (move.castle) return (move.castle === 'king' ? 'O-O' : 'O-O-O') + suffix
  const capture = !!move.captured || !!move.enPassant
  const to = squareName(move.to)
  if (!piece || piece.kind === 'pawn') {
    const promotion = move.promotion ? `=${LETTER[move.promotion]}` : ''
    return `${capture ? `${squareName(move.from)[0]}x` : ''}${to}${promotion}${suffix}`
  }
  // When another piece of the same kind can reach the square, the file tells them apart, else the rank, else both.
  const rivals = getAllMoves(state).filter(m =>
    !sameSquare(m.from, move.from) && sameSquare(m.to, move.to) && getPiece(state, m.from)?.kind === piece.kind)
  const name = squareName(move.from)
  const from = !rivals.length ? ''
    : !rivals.some(m => m.from.col === move.from.col) ? name[0]
    : !rivals.some(m => m.from.row === move.from.row) ? name[1]
    : name
  return `${LETTER[piece.kind]}${from}${capture ? 'x' : ''}${to}${suffix}`
}

function square(name: string): Square {
  return { row: 8 - Number(name[1]), col: name.charCodeAt(0) - 97 }
}

/** The moves of a game given in UCI from the start position, with their SAN. Stops at the first move that is not legal. */
export function replay(uci: readonly string[]): { moves: Move[]; san: string[] } {
  let state = newChessState()
  const out = { moves: [] as Move[], san: [] as string[] }
  for (const text of uci) {
    const to = square(text.slice(2, 4))
    const promotion = PROMOTION[text[4] ?? '']
    const move = getMoves(state, square(text.slice(0, 2))).find(m => sameSquare(m.to, to) && m.promotion === promotion)
    if (!move) break
    out.moves.push(move)
    out.san.push(san(state, move))
    state = applyMove(state, move)
  }
  return out
}
