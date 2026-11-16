import { Chess, DEFAULT_POSITION, type Move } from 'chess.js';
import type { ChessOutcome, Color, DrawClaim, MoveRecord, PositionSnapshot } from '../../contracts/match.js';

export const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const color = (value: 'w' | 'b'): Color => value === 'w' ? 'white' : 'black';
const uci = (move: Move): string => `${move.from}${move.to}${move.promotion ?? ''}`;

export class IllegalMoveError extends Error {}

export class ChessEngine {
  readonly #chess: Chess;
  readonly #initialFen: string;
  readonly #repetitions = new Map<string, number>();

  constructor(fen = DEFAULT_POSITION) {
    this.#chess = new Chess(fen);
    this.#initialFen = this.#chess.fen();
    this.#recordPosition();
  }

  #recordPosition(): void {
    // Canonical FEN comes from chess.js (including only legally usable en passant).
    const key = this.#chess.fen().split(' ').slice(0, 4).join(' ');
    this.#repetitions.set(key, (this.#repetitions.get(key) ?? 0) + 1);
  }

  get fen(): string { return this.#chess.fen(); }
  get turn(): Color { return color(this.#chess.turn()); }
  get ply(): number { return this.#chess.history().length; }
  get halfmoveClock(): number { return Number(this.fen.split(' ')[4]); }
  get repetitionCount(): number {
    return this.#repetitions.get(this.fen.split(' ').slice(0, 4).join(' ')) ?? 1;
  }
  legalMovesUci(): string[] { return this.#chess.moves({ verbose: true }).map(uci); }

  uciToSan(move: string): string {
    const found = UCI_PATTERN.test(move) && this.#chess.moves({ verbose: true }).find(candidate => uci(candidate) === move);
    if (!found) throw new IllegalMoveError(`Illegal UCI move: ${move}`);
    return found.san;
  }

  sanToUci(san: string): string {
    const found = this.#chess.moves({ verbose: true }).find(candidate => candidate.san === san);
    if (!found) throw new IllegalMoveError(`Illegal SAN move: ${san}`);
    return uci(found);
  }

  applyMove(move: string): MoveRecord {
    if (this.outcome()) throw new IllegalMoveError('The chess game has already ended');
    // Match exactly against generated moves: chess.js permissive SAN parsing is not used for UCI.
    const san = this.uciToSan(move);
    const accepted = this.#chess.move(san, { strict: true });
    this.#recordPosition();
    return this.#record(accepted, this.ply);
  }

  #record(move: Move, ply: number): MoveRecord {
    return { ply, color: color(move.color), uci: uci(move), san: move.san, before: move.before, after: move.after };
  }

  claimableDraws(): DrawClaim[] {
    if (this.outcome()) return [];
    const claims: DrawClaim[] = [];
    if (this.#chess.isThreefoldRepetition()) claims.push('ThreefoldRepetition');
    if (this.#chess.isDrawByFiftyMoves()) claims.push('FiftyMoves');
    return claims;
  }

  outcome(): ChessOutcome | null {
    if (this.#chess.isCheckmate()) {
      const winner = this.turn === 'white' ? 'black' : 'white';
      return { kind: 'Chess', reason: 'Checkmate', winner, score: winner === 'white' ? '1-0' : '0-1' };
    }
    const reason = this.#chess.isStalemate() ? 'Stalemate'
      : this.#chess.isInsufficientMaterial() ? 'InsufficientMaterial'
      : this.repetitionCount >= 5 ? 'FivefoldRepetition'
      : this.halfmoveClock >= 150 ? 'SeventyFiveMoves' : null;
    return reason ? { kind: 'Chess', reason, score: '1/2-1/2', winner: null } : null;
  }

  exportPgn(score: '1-0' | '0-1' | '1/2-1/2' | '*' = this.outcome()?.score ?? '*'): string {
    this.#chess.setHeader('Result', score);
    return this.#chess.pgn();
  }

  snapshot(): PositionSnapshot {
    const history = this.#chess.history({ verbose: true }).map((move, index) => this.#record(move, index + 1));
    return {
      fen: this.fen, ascii: this.#chess.ascii(), turn: this.turn, inCheck: this.#chess.inCheck(),
      legalMoves: this.legalMovesUci(), history, positions: [this.#initialFen, ...history.map(move => move.after)],
      halfmoveClock: this.halfmoveClock, repetitionCount: this.repetitionCount,
      claimableDraws: this.claimableDraws(), outcome: this.outcome(),
    };
  }
}
