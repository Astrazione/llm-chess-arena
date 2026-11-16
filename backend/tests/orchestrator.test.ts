import { DEFAULT_POSITION, Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameOrchestrator, type PlayersFactory } from '../src/application/game-orchestrator.js';
import { mockPlayersFactory, normalizeConfig } from '../src/application/match-service.js';
import type { CompletionRequest, CreateMatchRequest, GameEvent } from '../src/contracts/match.js';
import type { CompletionResponse, LlmProvider, ModelConfiguration } from '../src/llm/provider.js';
import { ChessEngine } from '../src/domain/chess/engine.js';

const games: GameOrchestrator[] = [];
afterEach(async () => { await Promise.all(games.splice(0).map(game => game.close())); });
function create(input: CreateMatchRequest = {}, factory: PlayersFactory = mockPlayersFactory, fen?: string) {
  const game = new GameOrchestrator(normalizeConfig(input), factory, fen);
  games.push(game);
  return game;
}
function providerWith(complete: LlmProvider['complete']): LlmProvider {
  return { probe: async () => ({ available: true, capabilities: { temperature: false, maxOutputTokens: false } }), complete };
}
function withWhite(provider: LlmProvider): PlayersFactory {
  return config => {
    const players = mockPlayersFactory(config);
    players.white.provider = provider;
    return players;
  };
}
function deferredProvider() {
  const pending: { resolve: (response: CompletionResponse) => void; signal: AbortSignal; request: CompletionRequest }[] = [];
  const complete = vi.fn((_config: ModelConfiguration, request: CompletionRequest, signal: AbortSignal) =>
    new Promise<CompletionResponse>(resolve => { pending.push({ resolve, signal, request }); }));
  return { provider: providerWith(complete), pending, complete };
}
const reply = (move: string): CompletionResponse => ({ rawText: JSON.stringify({ move }), responseTimeMs: 1 });

describe('GameOrchestrator', () => {
  it('runs two scripted models to a real checkmate with correct PGN and events', async () => {
    const game = create({ players: {
      white: { strategy: 'ScriptedMoves', moves: ['f2f3', 'g2g4'] },
      black: { strategy: 'ScriptedMoves', moves: ['e7e5', 'd8h4'] },
    } });
    game.start();
    await game.idle();
    const snapshot = game.snapshot();
    expect(snapshot.status).toBe('Completed');
    expect(snapshot.result).toMatchObject({ kind: 'Chess', reason: 'Checkmate', winner: 'black' });
    expect(snapshot.position.history.map(move => move.uci)).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(snapshot.attempts.map(attempt => attempt.color)).toEqual(['white', 'black', 'white', 'black']);
    expect(snapshot.attempts.every(attempt => attempt.status === 'Accepted')).toBe(true);
    const replay = new Chess();
    replay.loadPgn(snapshot.pgn);
    expect(replay.fen()).toBe(snapshot.position.fen);
    expect(replay.getHeaders().Result).toBe('0-1');
    const events = game.events.read(0, 100).events;
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-2)?.type).toBe('GameCompleted');
    expect(events.at(-1)?.type).toBe('OperationSettled');
    expect(events.find(event => event.type === 'MoveRequested')?.data.attempt?.status).toBe('Pending');
  });

  it('plays deterministic random opponents without external APIs', async () => {
    const first = create({ maxPlies: 16 });
    const second = create({ maxPlies: 16 });
    first.start(); second.start();
    await Promise.all([first.idle(), second.idle()]);
    expect(first.snapshot().position.history).toEqual(second.snapshot().position.history);
    expect(first.snapshot().attempts.every(attempt => attempt.status === 'Accepted')).toBe(true);
    expect(first.snapshot().result).toEqual({ kind: 'Limit', reason: 'MaxPlies', score: '*', winner: null });
  });

  it('retries an illegal move from the unchanged position and passes feedback', async () => {
    const game = create({ maxRetries: 1, players: {
      white: { strategy: 'ScriptedMoves', moves: ['e2e5', 'e2e4'] }, black: { strategy: 'RandomLegalMove' },
    } });
    const result = await game.nextMove();
    expect(result.status).toBe('Paused');
    expect(result.position.history).toHaveLength(1);
    expect(result.attempts.map(attempt => attempt.status)).toEqual(['Rejected', 'Accepted']);
    expect(result.attempts[0]).toMatchObject({ rawText: '{"move":"e2e5"}', error: { code: 'IllegalMove' } });
    expect(result.attempts[1]?.request.feedback?.code).toBe('IllegalMove');
    expect(result.attempts.every(attempt => attempt.request.position.fen === DEFAULT_POSITION)).toBe(true);
    expect(result.position.turn).toBe('black');
  });

  it.each([
    ['InvalidFormat', '{not-json'],
    ['InvalidFormat', '{"move":"e4"}'],
    ['InvalidFormat', '{"move":"e2e4","analysis":"extra"}'],
    ['InvalidFormat', 'null'],
    ['EmptyResponse', '  '],
    ['IllegalMove', '{"move":"e2e5"}'],
  ])('classifies %s responses without changing the board (%s)', async (code, rawText) => {
    const game = create({ maxRetries: 1 }, withWhite(providerWith(async () => ({ rawText, responseTimeMs: 1 }))));
    const result = await game.nextMove();
    expect(result.status).toBe('Completed');
    expect(result.result).toMatchObject({ kind: 'TechnicalLoss', reason: code, winner: 'black', loser: 'white' });
    expect(result.position.fen).toBe(DEFAULT_POSITION);
    expect(result.position.positions).toEqual([DEFAULT_POSITION]);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every(attempt => attempt.error?.code === code && attempt.rawText === rawText)).toBe(true);
    expect(result.position.history).toHaveLength(0);
  });

  it('records provider failures without exposing exception contents', async () => {
    const game = create({ maxRetries: 0 }, withWhite(providerWith(async () => { throw new Error('secret-token'); })));
    const result = await game.nextMove();
    expect(result.result).toMatchObject({ kind: 'TechnicalLoss', reason: 'ProviderError' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(game.events.read().events.some(event => event.type === 'ProviderFailed')).toBe(true);
  });

  it('does not attribute an internal chess engine failure to the model', async () => {
    const game = create();
    const failingEngine = vi.spyOn(ChessEngine.prototype, 'applyMove').mockImplementationOnce(() => { throw new Error('engine failure'); });
    try {
      const result = await game.nextMove();
      expect(result.result).toEqual({ kind: 'Stopped', reason: 'InternalError', score: '*', winner: null });
      expect(result.position.fen).toBe(DEFAULT_POSITION);
      expect(result.attempts[0]?.status).toBe('Cancelled');
    } finally { failingEngine.mockRestore(); }
  });

  it('times out even a provider that ignores cancellation and discards its late reply', async () => {
    const controlled = deferredProvider();
    const game = create({ maxRetries: 0, players: {
      white: { strategy: 'DelayedResponse', timeoutMs: 20 }, black: { strategy: 'RandomLegalMove' },
    } }, withWhite(controlled.provider));
    const result = await game.nextMove();
    expect(result.result).toMatchObject({ kind: 'TechnicalLoss', reason: 'Timeout' });
    expect(controlled.pending[0]?.signal.aborted).toBe(true);
    controlled.pending[0]!.resolve(reply('e2e4'));
    await Promise.resolve();
    expect(game.snapshot()).toEqual(result);
  });

  it('pauses an active request, accepts it, and resumes without starting an extra move', async () => {
    const controlled = deferredProvider();
    const game = create({ maxPlies: 2 }, withWhite(controlled.provider));
    game.start();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(1));
    expect(game.pause()).toMatchObject({ status: 'Paused', busy: true });
    expect(() => game.resume()).toThrow('already in progress');
    controlled.pending[0]!.resolve(reply('e2e4'));
    await game.idle();
    expect(game.snapshot()).toMatchObject({ status: 'Paused', busy: false });
    expect(game.snapshot().position.history).toHaveLength(1);
    expect(game.snapshot().attempts).toHaveLength(1);
    game.resume();
    await game.idle();
    expect(game.snapshot().position.history).toHaveLength(2);
    expect(game.snapshot().result?.kind).toBe('Limit');
  });

  it('does not launch retries while paused and preserves the retry budget for NextMove', async () => {
    const controlled = deferredProvider();
    const game = create({ maxRetries: 1 }, withWhite(controlled.provider));
    game.start();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(1));
    game.pause();
    controlled.pending[0]!.resolve(reply('e2e5'));
    await game.idle();
    expect(game.snapshot().status).toBe('Paused');
    expect(controlled.pending).toHaveLength(1);
    const step = game.nextMove();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(2));
    expect(controlled.pending[1]!.request.feedback?.code).toBe('IllegalMove');
    controlled.pending[1]!.resolve(reply('e2e5'));
    const result = await step;
    expect(result.attempts.map(attempt => attempt.attemptNumber)).toEqual([1, 2]);
    expect(result.result?.kind).toBe('TechnicalLoss');
    expect(result.position.fen).toBe(DEFAULT_POSITION);
  });

  it('performs exactly one move per NextMove and rejects concurrent steps', async () => {
    const game = create();
    const first = game.nextMove();
    await expect(game.nextMove()).rejects.toMatchObject({ code: 'OperationInProgress' });
    expect((await first).position.history).toHaveLength(1);
    await game.idle();
    expect(game.snapshot()).toMatchObject({ status: 'Paused', busy: false });
    expect((await game.nextMove()).position.history).toHaveLength(2);
  });

  it('does not start two automatic loops on repeated Start/Resume', async () => {
    const controlled = deferredProvider();
    const game = create({}, withWhite(controlled.provider));
    game.start(); game.start();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(1));
    expect(game.resume().status).toBe('Running');
    expect(controlled.complete).toHaveBeenCalledTimes(1);
    game.stop();
    await game.idle();
  });

  it('resets during a request and never lets an old completion unlock or mutate the new game', async () => {
    const controlled = deferredProvider();
    const game = create({}, withWhite(controlled.provider));
    const oldId = game.snapshot().gameId;
    const oldStep = game.nextMove().catch(error => error);
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(1));
    const reset = game.reset();
    expect(reset.gameId).not.toBe(oldId);
    expect(reset.position.fen).toBe(DEFAULT_POSITION);
    expect(reset.status).toBe('Created');
    expect(reset.attempts).toEqual([]);
    expect(controlled.pending[0]!.signal.aborted).toBe(true);
    const newStep = game.nextMove();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(2));
    controlled.pending[0]!.resolve(reply('e2e4'));
    expect(await oldStep).toMatchObject({ code: 'SessionChanged' });
    expect(game.snapshot().busy).toBe(true);
    expect(game.snapshot().position.fen).toBe(DEFAULT_POSITION);
    controlled.pending[1]!.resolve(reply('d2d4'));
    expect((await newStep).position.history.map(move => move.uci)).toEqual(['d2d4']);
    const events = game.events.read().events;
    expect(events.some(event => event.gameId === oldId && event.type === 'AttemptCancelled')).toBe(true);
    expect(events.some(event => event.gameId === oldId && event.type === 'MoveAccepted')).toBe(false);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it('Stop cancels a request definitively without declaring a chess winner', async () => {
    const controlled = deferredProvider();
    const game = create({}, withWhite(controlled.provider));
    game.start();
    await vi.waitFor(() => expect(controlled.pending).toHaveLength(1));
    const stopped = game.stop();
    expect(stopped).toMatchObject({ status: 'Stopped', busy: false, result: { kind: 'Stopped', score: '*', winner: null } });
    expect(stopped.attempts[0]?.status).toBe('Cancelled');
    await game.idle();
    controlled.pending[0]!.resolve(reply('e2e4'));
    await Promise.resolve();
    expect(game.snapshot()).toEqual(stopped);
    expect(() => game.resume()).toThrow();
    expect(game.stop()).toEqual(stopped);
  });

  it('checks both models before requesting a move', async () => {
    const game = create({}, config => {
      const players = mockPlayersFactory(config);
      players.black.provider = { probe: async () => ({ available: false, capabilities: { temperature: false, maxOutputTokens: false } }), complete: vi.fn() };
      return players;
    });
    await game.nextMove();
    expect(game.snapshot().attempts).toHaveLength(0);
    expect(game.snapshot().result).toMatchObject({ kind: 'TechnicalLoss', loser: 'black', reason: 'ProviderError' });
  });

  it('completes a stalemated initial test position without asking a model', async () => {
    const game = create({}, mockPlayersFactory, '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    await game.nextMove();
    expect(game.snapshot().result).toMatchObject({ kind: 'Chess', reason: 'Stalemate' });
    expect(game.snapshot().attempts).toEqual([]);
  });

  it('allows a valid draw claim explicitly and rejects one in the initial position', async () => {
    const game = create({ players: {
      white: { strategy: 'ScriptedMoves', moves: ['g1f3', 'f3g1', 'g1f3', 'f3g1'] },
      black: { strategy: 'ScriptedMoves', moves: ['g8f6', 'f6g8', 'g8f6', 'f6g8'] },
    } });
    expect(() => game.claimDraw('ThreefoldRepetition')).toThrow();
    for (let index = 0; index < 8; index++) await game.nextMove();
    expect(game.snapshot().status).toBe('Paused');
    expect(game.snapshot().position.claimableDraws).toContain('ThreefoldRepetition');
    expect(game.claimDraw('ThreefoldRepetition').result).toEqual({ kind: 'ClaimedDraw', reason: 'ThreefoldRepetition', score: '1/2-1/2', winner: null });
  });

  it('keeps mode A free of legal moves and mode B includes the exact list', async () => {
    const a = create({ mode: 'A' }); const b = create({ mode: 'B', systemPrompt: 'Custom instruction' });
    const first = await a.nextMove(); const second = await b.nextMove();
    expect(first.attempts[0]?.request.position.legalMoves).toBeUndefined();
    expect(first.attempts[0]?.request.userPrompt).not.toContain('legalMoves');
    expect(second.attempts[0]?.request.position.legalMoves).toHaveLength(20);
    expect(second.attempts[0]?.request.systemPrompt).toBe('Custom instruction');
  });

  it('isolates event listeners and paginates an immutable journal', async () => {
    const game = create();
    const received: GameEvent[] = [];
    game.events.subscribe(() => { throw new Error('observer failed'); });
    const unsubscribe = game.events.subscribe(event => { received.push(event); event.data.message = 'mutated'; });
    await game.nextMove();
    await Promise.resolve();
    expect(received.length).toBeGreaterThan(0);
    expect(game.events.read().events.every(event => event.data.message !== 'mutated')).toBe(true);
    const page = game.events.read(1, 2);
    expect(page.events.map(event => event.sequence)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);
    unsubscribe();
  });
});
