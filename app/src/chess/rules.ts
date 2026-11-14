// Chess rules and the small machine opponent.
//
// The board is a plain 8x8 array, row 0 is rank 8 and row 7 is rank 1. White
// starts at the bottom, so white pawns move toward row 0. Pieces are objects
// with a color and a kind; an empty square is null. The engine has no DOM or
// screen code, which keeps the game faceplate independent.
//
// Moves are generated in two passes. The first pass knows how a piece moves and
// where it may capture. The second pass plays each candidate on a copied board
// and refuses the ones that leave the mover's king in check. Castling is checked
// against attacked squares during the first pass because the king never crosses
// a square it could be taken on.

export type Color = 'white' | 'black'
export type Kind = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king'

export interface Piece {
  color: Color
  kind: Kind
}

export type Board = (Piece | null)[][]

export interface Square {
  row: number
  col: number
}

export interface Move {
  from: Square
  to: Square
  captured: Piece | null
  promotion?: Kind
  castle?: 'king' | 'queen'
  enPassant?: boolean
}

export interface CastlingRights {
  whiteKing: boolean
  whiteQueen: boolean
  blackKing: boolean
  blackQueen: boolean
}

export interface ChessState {
  board: Board
  turn: Color
  castling: CastlingRights
  enPassant: Square | null
  halfmove: number
  fullmove: number
}

export interface GameResult {
  over: boolean
  text: string
}

const FILES = 'abcdefgh'

const VALUE: Record<Kind, number> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 0,
}

const KNIGHT_STEPS: Square[] = [
  { row: -2, col: -1 }, { row: -2, col: 1 },
  { row: -1, col: -2 }, { row: -1, col: 2 },
  { row: 1, col: -2 }, { row: 1, col: 2 },
  { row: 2, col: -1 }, { row: 2, col: 1 },
]

const STRAIGHT_STEPS: Square[] = [
  { row: -1, col: 0 }, { row: 1, col: 0 },
  { row: 0, col: -1 }, { row: 0, col: 1 },
]

const DIAGONAL_STEPS: Square[] = [
  { row: -1, col: -1 }, { row: -1, col: 1 },
  { row: 1, col: -1 }, { row: 1, col: 1 },
]

const KING_STEPS: Square[] = [...STRAIGHT_STEPS, ...DIAGONAL_STEPS]

export const other = (color: Color): Color => color === 'white' ? 'black' : 'white'

export const inside = (row: number, col: number): boolean =>
  row >= 0 && row < 8 && col >= 0 && col < 8

export const sameSquare = (a: Square, b: Square): boolean =>
  a.row === b.row && a.col === b.col

export const squareName = (square: Square): string =>
  FILES[square.col]! + String(8 - square.row)

export const pieceName = (piece: Piece): string =>
  `${piece.color} ${piece.kind}`

/** The starting position, with every castling right and no en passant target. */
export function newChessState(): ChessState {
  const board = emptyBoard()
  const back: Kind[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook']
  for (let col = 0; col < 8; col++) {
    board[0]![col] = { color: 'black', kind: back[col]! }
    board[1]![col] = { color: 'black', kind: 'pawn' }
    board[6]![col] = { color: 'white', kind: 'pawn' }
    board[7]![col] = { color: 'white', kind: back[col]! }
  }
  return {
    board,
    turn: 'white',
    castling: { whiteKing: true, whiteQueen: true, blackKing: true, blackQueen: true },
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
  }
}

export function emptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null))
}

export function getPiece(state: ChessState, square: Square): Piece | null {
  return inside(square.row, square.col) ? state.board[square.row]![square.col]! : null
}

export function setPiece(board: Board, square: Square, piece: Piece | null): void {
  if (inside(square.row, square.col)) board[square.row]![square.col] = piece
}

export function copyBoard(board: Board): Board {
  return board.map(row => row.slice())
}

/** Take the piece off a square and return it. Captures use this so the board
 * is emptied in one place rather than by a bare null assignment. */
export function killPiece(board: Board, square: Square): Piece | null {
  if (!inside(square.row, square.col)) return null
  const piece = board[square.row]![square.col]!
  board[square.row]![square.col] = null
  return piece
}

export function copyState(state: ChessState): ChessState {
  return {
    board: copyBoard(state.board),
    turn: state.turn,
    castling: { ...state.castling },
    enPassant: state.enPassant ? { ...state.enPassant } : null,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  }
}

export function findKing(state: ChessState, color: Color): Square | null {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row]![col]
      if (piece?.color === color && piece.kind === 'king') return { row, col }
    }
  }
  return null
}

/** Moves a piece can make without asking whether its own king is exposed. */
export function getPseudoMoves(state: ChessState, from: Square): Move[] {
  const piece = getPiece(state, from)
  if (!piece) return []
  if (piece.kind === 'pawn') return getPawnMoves(state, from, piece)
  if (piece.kind === 'knight') return getStepMoves(state, from, piece, KNIGHT_STEPS)
  if (piece.kind === 'king') return getKingMoves(state, from, piece)
  if (piece.kind === 'bishop') return getSlideMoves(state, from, piece, DIAGONAL_STEPS)
  if (piece.kind === 'rook') return getSlideMoves(state, from, piece, STRAIGHT_STEPS)
  return getSlideMoves(state, from, piece, [...STRAIGHT_STEPS, ...DIAGONAL_STEPS])
}

/** Every legal move for one piece, with checks applied. */
export function getMoves(state: ChessState, from: Square): Move[] {
  const piece = getPiece(state, from)
  if (!piece || piece.color !== state.turn) return []
  return getPseudoMoves(state, from).filter(move => {
    const next = applyMove(state, move)
    return !isCheck(next, piece.color)
  })
}

/** Every legal move for a color. The state turn is used when no color is passed. */
export function getAllMoves(state: ChessState, color: Color = state.turn): Move[] {
  const moves: Move[] = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row]![col]
      if (piece?.color !== color) continue
      for (const move of getPseudoMoves(state, { row, col })) {
        const next = applyMove(state, move)
        if (!isCheck(next, color)) moves.push(move)
      }
    }
  }
  return moves
}

function getPawnMoves(state: ChessState, from: Square, piece: Piece): Move[] {
  const moves: Move[] = []
  const direction = piece.color === 'white' ? -1 : 1
  const startRow = piece.color === 'white' ? 6 : 1
  const lastRow = piece.color === 'white' ? 0 : 7
  const one = { row: from.row + direction, col: from.col }

  if (inside(one.row, one.col) && !getPiece(state, one)) {
    addPawnMove(moves, state, from, one, null, lastRow)
    const two = { row: from.row + direction * 2, col: from.col }
    if (from.row === startRow && !getPiece(state, two)) {
      moves.push({ from, to: two, captured: null })
    }
  }

  for (const side of [-1, 1]) {
    const target = { row: from.row + direction, col: from.col + side }
    if (!inside(target.row, target.col)) continue
    const targetPiece = getPiece(state, target)
    if (targetPiece && targetPiece.color !== piece.color) {
      addPawnMove(moves, state, from, target, targetPiece, lastRow)
    } else if (state.enPassant && sameSquare(state.enPassant, target)) {
      const captured = getPiece(state, { row: from.row, col: target.col })
      moves.push({ from, to: target, captured, enPassant: true })
    }
  }

  return moves
}

function addPawnMove(
  moves: Move[], state: ChessState, from: Square, to: Square,
  captured: Piece | null, lastRow: number,
): void {
  // Promotion asks no question: a pawn that reaches the far rank becomes a
  // queen. The choice keeps the board and the score easy to read.
  const promotion = to.row === lastRow ? 'queen' : undefined
  moves.push({ from, to, captured, promotion })
}

function getStepMoves(state: ChessState, from: Square, piece: Piece, steps: Square[]): Move[] {
  const moves: Move[] = []
  for (const step of steps) {
    const to = { row: from.row + step.row, col: from.col + step.col }
    if (!inside(to.row, to.col)) continue
    const target = getPiece(state, to)
    if (target?.color === piece.color) continue
    moves.push({ from, to, captured: target })
  }
  return moves
}

function getSlideMoves(state: ChessState, from: Square, piece: Piece, steps: Square[]): Move[] {
  const moves: Move[] = []
  for (const step of steps) {
    let to = { row: from.row + step.row, col: from.col + step.col }
    while (inside(to.row, to.col)) {
      const target = getPiece(state, to)
      if (!target) {
        moves.push({ from, to, captured: null })
      } else {
        if (target.color !== piece.color) moves.push({ from, to, captured: target })
        break
      }
      to = { row: to.row + step.row, col: to.col + step.col }
    }
  }
  return moves
}

function getKingMoves(state: ChessState, from: Square, piece: Piece): Move[] {
  const moves = getStepMoves(state, from, piece, KING_STEPS)
  const rank = piece.color === 'white' ? 7 : 0
  if (from.row !== rank || from.col !== 4) return moves
  if (isCheck(state, piece.color)) return moves

  const right = piece.color === 'white' ? state.castling.whiteKing : state.castling.blackKing
  const left = piece.color === 'white' ? state.castling.whiteQueen : state.castling.blackQueen
  const rook = (col: number): boolean => {
    const target = getPiece(state, { row: rank, col })
    return target?.color === piece.color && target.kind === 'rook'
  }
  const clear = (col: number): boolean => !getPiece(state, { row: rank, col })
  const safe = (col: number): boolean =>
    !isSquareAttacked(state, { row: rank, col }, other(piece.color))

  if (right && rook(7) && clear(5) && clear(6) && safe(5) && safe(6)) {
    moves.push({
      from,
      to: { row: rank, col: 6 },
      captured: null,
      castle: 'king',
    })
  }
  if (left && rook(0) && clear(1) && clear(2) && clear(3) && safe(2) && safe(3)) {
    moves.push({
      from,
      to: { row: rank, col: 2 },
      captured: null,
      castle: 'queen',
    })
  }
  return moves
}

/** True when a piece of `byColor` could take the square on its next move. */
export function isSquareAttacked(state: ChessState, square: Square, byColor: Color): boolean {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row]![col]
      if (piece?.color !== byColor) continue
      if (attacksSquare(state, { row, col }, square, piece)) return true
    }
  }
  return false
}

function attacksSquare(state: ChessState, from: Square, to: Square, piece: Piece): boolean {
  const rowStep = to.row - from.row
  const colStep = to.col - from.col

  if (piece.kind === 'pawn') {
    const direction = piece.color === 'white' ? -1 : 1
    return rowStep === direction && Math.abs(colStep) === 1
  }
  if (piece.kind === 'knight') {
    return (Math.abs(rowStep) === 2 && Math.abs(colStep) === 1)
      || (Math.abs(rowStep) === 1 && Math.abs(colStep) === 2)
  }
  if (piece.kind === 'king') {
    return Math.abs(rowStep) <= 1 && Math.abs(colStep) <= 1 && (rowStep !== 0 || colStep !== 0)
  }

  const straight = rowStep === 0 || colStep === 0
  const diagonal = Math.abs(rowStep) === Math.abs(colStep)
  if (piece.kind === 'rook' && !straight) return false
  if (piece.kind === 'bishop' && !diagonal) return false
  if (piece.kind === 'queen' && !straight && !diagonal) return false

  const rowDirection = Math.sign(rowStep)
  const colDirection = Math.sign(colStep)
  let row = from.row + rowDirection
  let col = from.col + colDirection
  while (row !== to.row || col !== to.col) {
    if (getPiece(state, { row, col })) return false
    row += rowDirection
    col += colDirection
  }
  return true
}

/** True when the king of `color` is attacked. */
export function isCheck(state: ChessState, color: Color): boolean {
  const king = findKing(state, color)
  return king ? isSquareAttacked(state, king, other(color)) : false
}

/** True when the side to move has no legal move and its king is attacked. */
export function checkmate(state: ChessState): boolean {
  return isCheck(state, state.turn) && getAllMoves(state).length === 0
}

/** True when the side to move has no legal move and its king is not attacked. */
export function stalemate(state: ChessState): boolean {
  return !isCheck(state, state.turn) && getAllMoves(state).length === 0
}

/** A draw reason, or null while the game can continue. */
export function draw(state: ChessState): string | null {
  if (stalemate(state)) return 'stalemate'
  if (state.halfmove >= 100) return 'fifty-move rule'
  if (insufficientMaterial(state)) return 'insufficient material'
  return null
}

function insufficientMaterial(state: ChessState): boolean {
  const pieces: Piece[] = []
  for (const row of state.board) {
    for (const piece of row) if (piece) pieces.push(piece)
  }
  if (pieces.some(piece => piece.kind === 'pawn' || piece.kind === 'rook' || piece.kind === 'queen')) {
    return false
  }
  const minors = pieces.filter(piece => piece.kind === 'knight' || piece.kind === 'bishop')
  return minors.length <= 1
}

/** The status line, and whether the game has stopped. */
export function resultOf(state: ChessState): GameResult {
  if (checkmate(state)) return { over: true, text: `${other(state.turn)} wins by checkmate` }
  const reason = draw(state)
  if (reason) return { over: true, text: `draw by ${reason}` }
  return { over: false, text: `${state.turn} to move` }
}

/** A move played on a copied state. The original state is never changed. */
export function applyMove(state: ChessState, move: Move): ChessState {
  const next = copyState(state)
  const piece = getPiece(state, move.from)
  if (!piece) return next

  setPiece(next.board, move.from, null)
  if (move.enPassant) {
    killPiece(next.board, { row: move.from.row, col: move.to.col })
  }
  killPiece(next.board, move.to)
  setPiece(next.board, move.to, move.promotion ? { color: piece.color, kind: move.promotion } : piece)

  if (move.castle) {
    const rank = move.from.row
    const rookFrom = move.castle === 'king' ? 7 : 0
    const rookTo = move.castle === 'king' ? 5 : 3
    const rook = getPiece(state, { row: rank, col: rookFrom })
    setPiece(next.board, { row: rank, col: rookFrom }, null)
    setPiece(next.board, { row: rank, col: rookTo }, rook)
  }

  updateCastling(next, piece.color, move)
  next.enPassant = null
  if (piece.kind === 'pawn' && Math.abs(move.to.row - move.from.row) === 2) {
    next.enPassant = {
      row: (move.from.row + move.to.row) / 2,
      col: move.from.col,
    }
  }

  next.halfmove = piece.kind === 'pawn' || move.captured ? 0 : next.halfmove + 1
  if (state.turn === 'black') next.fullmove += 1
  next.turn = other(state.turn)
  return next
}

function updateCastling(state: ChessState, color: Color, move: Move): void {
  const piece = getPiece(state, move.to)
  if (piece?.kind === 'king') {
    if (color === 'white') {
      state.castling.whiteKing = false
      state.castling.whiteQueen = false
    } else {
      state.castling.blackKing = false
      state.castling.blackQueen = false
    }
  }
  if (piece?.kind === 'rook') clearRookRight(state, color, move.to)
  if (move.captured?.kind === 'rook') clearRookRight(state, move.captured.color, move.to)
}

function clearRookRight(state: ChessState, color: Color, square: Square): void {
  if (square.col === 0 && square.row === (color === 'white' ? 7 : 0)) {
    if (color === 'white') state.castling.whiteQueen = false
    else state.castling.blackQueen = false
  }
  if (square.col === 7 && square.row === (color === 'white' ? 7 : 0)) {
    if (color === 'white') state.castling.whiteKing = false
    else state.castling.blackKing = false
  }
}

/** Material and a little center control, from the side to move's view. */
export function evaluate(state: ChessState): number {
  const sign = state.turn === 'white' ? 1 : -1
  let score = 0
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row]![col]
      if (!piece) continue
      const value = VALUE[piece.kind]
      const center = 3.5 - Math.abs(3.5 - row) + 3.5 - Math.abs(3.5 - col)
      const bonus = piece.kind === 'pawn' || piece.kind === 'knight' ? center : 0
      score += (piece.color === state.turn ? 1 : -1) * (value + bonus)
    }
  }
  return score * sign
}

/**
 * The machine's choice: a three-ply search with alpha-beta pruning. The root
 * move, the answer to it and one reply are enough to avoid hanging a piece
 * without making the faceplate wait. Equal scores are collected so the game
 * does not repeat the same opening every time.
 */
export function chooseMachineMove(state: ChessState): Move | null {
  const moves = getAllMoves(state, state.turn)
  if (!moves.length) return null

  let bestScore = -Infinity
  let bestMoves: Move[] = []
  for (const move of moves) {
    const next = applyMove(state, move)
    const score = -search(next, 2, -Infinity, Infinity)
    if (score > bestScore) {
      bestScore = score
      bestMoves = [move]
    } else if (score === bestScore) {
      bestMoves.push(move)
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)] ?? null
}

function search(state: ChessState, depth: number, alpha: number, beta: number): number {
  if (depth === 0) return evaluate(state)
  const moves = getAllMoves(state, state.turn)
  if (!moves.length) return isCheck(state, state.turn) ? -100000 + depth : 0

  let best = -Infinity
  for (const move of moves) {
    const score = -search(applyMove(state, move), depth - 1, -beta, -alpha)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}
