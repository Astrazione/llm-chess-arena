import { Chess, DEFAULT_POSITION } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { ChessEngine } from '../src/domain/chess/engine.js';

describe('ChessEngine', () => {
  it('creates the standard position and returns detached history/snapshots', () => {
    const engine = new ChessEngine();
    expect(engine.fen).toBe(DEFAULT_POSITION);
    expect(engine.snapshot()).toMatchObject({ turn: 'white', inCheck: false, history: [], positions: [DEFAULT_POSITION], outcome: null });
    expect(engine.legalMovesUci()).toHaveLength(20);
    expect(engine.snapshot().ascii).toContain('a  b  c  d  e  f  g  h');
    engine.snapshot().legalMoves.length = 0;
    expect(engine.legalMovesUci()).toHaveLength(20);
  });

  it('converts UCI/SAN against the current position without changing it', () => {
    const engine = new ChessEngine();
    expect(engine.uciToSan('e2e4')).toBe('e4');
    expect(engine.sanToUci('e4')).toBe('e2e4');
    expect(engine.fen).toBe(DEFAULT_POSITION);
    const move = engine.applyMove('e2e4');
    expect(move).toMatchObject({ ply: 1, color: 'white', uci: 'e2e4', san: 'e4', before: DEFAULT_POSITION });
    expect(engine.turn).toBe('black');
    expect(engine.snapshot().positions).toEqual([DEFAULT_POSITION, engine.fen]);
    expect(() => engine.sanToUci('e4')).toThrow();
  });

  it.each(['e2e5', 'e2e4q', 'a1a1', 'e4', 'E2E4', 'e7e8z'])('rejects %s without changing any state', move => {
    const engine = new ChessEngine();
    const before = engine.snapshot();
    expect(() => engine.applyMove(move)).toThrow();
    expect(engine.snapshot()).toEqual(before);
  });

  it('recognizes a check without ending the game', () => {
    const engine = new ChessEngine();
    ['e2e4', 'f7f6', 'd1h5'].forEach(move => engine.applyMove(move));
    expect(engine.snapshot()).toMatchObject({ inCheck: true, turn: 'black', outcome: null });
    expect(engine.uciToSan('g7g6')).toBe('g6');
  });

  it('recognizes checkmate, forbids further moves and produces valid PGN', () => {
    const engine = new ChessEngine();
    ['f2f3', 'e7e5', 'g2g4', 'd8h4'].forEach(move => engine.applyMove(move));
    expect(engine.outcome()).toEqual({ kind: 'Chess', reason: 'Checkmate', winner: 'black', score: '0-1' });
    expect(engine.snapshot().history.at(-1)?.san).toBe('Qh4#');
    expect(() => engine.applyMove('a2a3')).toThrow();
    const replay = new Chess();
    replay.loadPgn(engine.exportPgn());
    expect(replay.fen()).toBe(engine.fen);
    expect(replay.getHeaders().Result).toBe('0-1');
  });

  it.each([
    ['e1g1', 'e8c8', 'O-O', 'O-O-O'],
    ['e1c1', 'e8g8', 'O-O-O', 'O-O'],
  ])('supports castling %s / %s', (white, black, whiteSan, blackSan) => {
    const engine = new ChessEngine('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(engine.uciToSan(white!)).toBe(whiteSan);
    engine.applyMove(white!);
    expect(engine.uciToSan(black!)).toBe(blackSan);
    engine.applyMove(black!);
    const board = new Chess(engine.fen);
    expect(board.get(white === 'e1g1' ? 'g1' : 'c1')?.type).toBe('k');
    expect(board.get(black === 'e8g8' ? 'f8' : 'd8')?.type).toBe('r');
  });

  it('does not castle through an attacked square', () => {
    const engine = new ChessEngine('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1');
    expect(engine.legalMovesUci()).not.toContain('e1g1');
    expect(() => engine.applyMove('e1g1')).toThrow();
  });

  it('applies en passant and removes the captured pawn', () => {
    const engine = new ChessEngine();
    ['e2e4', 'a7a6', 'e4e5', 'd7d5'].forEach(move => engine.applyMove(move));
    expect(engine.uciToSan('e5d6')).toBe('exd6');
    engine.applyMove('e5d6');
    const board = new Chess(engine.fen);
    expect(board.get('d6')).toMatchObject({ type: 'p', color: 'w' });
    expect(board.get('d5')).toBeUndefined();
  });

  it('expires en passant after another move', () => {
    const engine = new ChessEngine();
    ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'g1f3', 'a6a5'].forEach(move => engine.applyMove(move));
    const before = engine.snapshot();
    expect(() => engine.applyMove('e5d6')).toThrow();
    expect(engine.snapshot()).toEqual(before);
  });

  it.each(['q', 'r', 'b', 'n'])('supports promotion to %s', promotion => {
    const engine = new ChessEngine('7k/P7/8/8/8/8/8/7K w - - 0 1');
    expect(() => engine.applyMove('a7a8')).toThrow();
    engine.applyMove(`a7a8${promotion}`);
    expect(new Chess(engine.fen).get('a8')?.type).toBe(promotion);
  });

  it('recognizes stalemate distinctly', () => {
    const engine = new ChessEngine('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(engine.snapshot().inCheck).toBe(false);
    expect(engine.outcome()?.reason).toBe('Stalemate');
  });

  it.each(['7k/8/8/8/8/8/8/7K w - - 0 1', '7k/8/8/8/8/8/8/5B1K w - - 0 1'])('recognizes insufficient material in %s', fen => {
    expect(new ChessEngine(fen).outcome()?.reason).toBe('InsufficientMaterial');
  });

  it('distinguishes threefold claims from automatic fivefold repetition', () => {
    const engine = new ChessEngine();
    const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    [...cycle, ...cycle].forEach(move => engine.applyMove(move));
    expect(engine.snapshot().repetitionCount).toBe(3);
    expect(engine.claimableDraws()).toContain('ThreefoldRepetition');
    expect(engine.outcome()).toBeNull();
    [...cycle, ...cycle].forEach(move => engine.applyMove(move));
    expect(engine.outcome()?.reason).toBe('FivefoldRepetition');
  });

  it('treats fifty moves as claimable, and seventy-five as automatic', () => {
    const fifty = new ChessEngine('7k/8/8/8/8/8/R7/7K w - - 100 51');
    expect(fifty.claimableDraws()).toEqual(['FiftyMoves']);
    expect(fifty.outcome()).toBeNull();
    expect(new ChessEngine('7k/8/8/8/8/8/R7/7K w - - 150 76').outcome()?.reason).toBe('SeventyFiveMoves');
  });

  it('gives checkmate precedence over seventy-five moves', () => {
    const engine = new ChessEngine('7k/8/5KQ1/8/8/8/8/8 w - - 149 76');
    engine.applyMove('g6g7');
    expect(engine.halfmoveClock).toBe(150);
    expect(engine.outcome()?.reason).toBe('Checkmate');
  });
});
