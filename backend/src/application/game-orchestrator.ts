import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToIo, setTimeout as delay } from 'node:timers/promises';
import type { Attempt, Color, DrawClaim, GameEvent, MatchConfig, MatchResult, MatchSnapshot, MatchStatus, MoveError } from '../contracts/match.js';
import { ChessEngine, IllegalMoveError } from '../domain/chess/engine.js';
import { EventJournal } from '../events/journal.js';
import { withDeadline } from '../llm/deadline.js';
import { ProviderRequestError, requestMetrics, type LlmProvider, type ModelConfiguration } from '../llm/provider.js';
import { buildMoveRequest } from './prompts.js';
import { MoveResponseError, parseMoveResponse } from './move-response.js';

export class MatchCommandError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}
export interface PlayerBinding { provider: LlmProvider; config: ModelConfiguration }
export type PlayersFactory = (config: MatchConfig) => Record<Color, PlayerBinding>;
interface Operation {
  controller: AbortController;
  single: boolean;
  attempt: Attempt | null;
  attemptStarted: number;
  delay: AbortController | null;
}
interface GameSession {
  gameId: string;
  generation: number;
  engine: ChessEngine;
  players: Record<Color, PlayerBinding>;
  status: MatchStatus;
  result: MatchResult | null;
  attempts: Attempt[];
  operation: Operation | null;
  probed: boolean;
  providerChecks: MatchSnapshot['providerChecks'];
  turn: { attempts: number; feedback?: MoveError } | null;
}

export class GameOrchestrator {
  readonly id = randomUUID();
  readonly events = new EventJournal();
  readonly #tasks = new Set<Promise<void>>();
  readonly #config: MatchConfig;
  #session: GameSession;
  #attemptSequence = 0;

  constructor(config: MatchConfig, readonly playersFactory: PlayersFactory, initialFen?: string) {
    this.#config = structuredClone(config);
    this.#session = this.#newSession(1, initialFen);
    this.#emit(this.#session, 'GameCreated');
  }

  #newSession(generation: number, fen?: string): GameSession {
    return {
      gameId: randomUUID(), generation, engine: new ChessEngine(fen), players: this.playersFactory(structuredClone(this.#config)),
      status: 'Created', result: null, attempts: [], operation: null, probed: false, providerChecks: [], turn: null,
    };
  }

  #emit(session: GameSession, type: GameEvent['type'], data: GameEvent['data'] = {}): void {
    this.events.publish({ matchId: this.id, gameId: session.gameId, type, status: session.status, ply: session.engine.ply, fen: session.engine.fen, data });
  }

  snapshot(): MatchSnapshot {
    const session = this.#session;
    return structuredClone({
      schemaVersion: 1, id: this.id, gameId: session.gameId, generation: session.generation,
      status: session.status, busy: session.operation !== null, config: this.#config,
      position: session.engine.snapshot(), attempts: session.attempts, result: session.result,
      providerChecks: session.providerChecks,
      pgn: session.engine.exportPgn(session.result?.score), lastEventSequence: this.events.lastSequence,
    });
  }

  #requireStatus(...allowed: MatchStatus[]): GameSession {
    const session = this.#session;
    if (!allowed.includes(session.status)) throw new MatchCommandError('InvalidTransition', `Cannot perform this command in ${session.status}`);
    return session;
  }

  #requireIdle(session: GameSession): void {
    if (session.operation) throw new MatchCommandError('OperationInProgress', 'A move or preflight is already in progress');
  }

  start(): MatchSnapshot {
    if (this.#session.status === 'Running') return this.snapshot();
    const session = this.#requireStatus('Created');
    session.status = 'Running';
    this.#emit(session, 'GameStarted');
    this.#launch(session, false);
    return this.snapshot();
  }

  pause(): MatchSnapshot {
    const session = this.#requireStatus('Running', 'Paused');
    if (session.status === 'Running') {
      session.status = 'Paused';
      session.operation?.delay?.abort();
      this.#emit(session, 'GamePaused');
    }
    return this.snapshot();
  }

  resume(): MatchSnapshot {
    if (this.#session.status === 'Running') return this.snapshot();
    const session = this.#requireStatus('Paused');
    this.#requireIdle(session);
    session.status = 'Running';
    this.#emit(session, 'GameResumed');
    this.#launch(session, false);
    return this.snapshot();
  }

  async nextMove(): Promise<MatchSnapshot> {
    const session = this.#requireStatus('Created', 'Paused');
    this.#requireIdle(session);
    const first = session.status === 'Created';
    session.status = 'Paused';
    if (first) {
      this.#emit(session, 'GameStarted');
      this.#emit(session, 'GamePaused');
    }
    await this.#launch(session, true);
    if (session !== this.#session) throw new MatchCommandError('SessionChanged', 'The game was reset during this command');
    return this.snapshot();
  }

  stop(reason: 'UserStop' | 'Reset' | 'ServerShutdown' | 'InternalError' = 'UserStop'): MatchSnapshot {
    if (this.#session.status === 'Stopped') return this.snapshot();
    const session = this.#requireStatus('Created', 'Running', 'Paused');
    session.status = 'Stopped';
    session.result = { kind: 'Stopped', reason, score: '*', winner: null };
    const operation = session.operation;
    if (operation) {
      if (operation.attempt) {
        this.#finishAttempt(operation, 'Cancelled');
        this.#emit(session, 'AttemptCancelled', { attempt: operation.attempt, message: reason });
        operation.attempt = null;
      }
      session.operation = null;
      operation.controller.abort(new Error('Game operation cancelled'));
    }
    this.#emit(session, 'GameStopped', { result: session.result });
    return this.snapshot();
  }

  reset(): MatchSnapshot {
    const previous = this.#session;
    if (previous.status !== 'Completed' && previous.status !== 'Stopped') this.stop('Reset');
    this.#session = this.#newSession(previous.generation + 1);
    this.#emit(this.#session, 'GameReset', { previousGameId: previous.gameId });
    return this.snapshot();
  }

  claimDraw(reason: DrawClaim): MatchSnapshot {
    const session = this.#requireStatus('Created', 'Paused');
    this.#requireIdle(session);
    if (!session.engine.claimableDraws().includes(reason)) throw new MatchCommandError('DrawNotClaimable', 'This draw is not claimable in the current position');
    this.#complete(session, { kind: 'ClaimedDraw', reason, score: '1/2-1/2', winner: null });
    return this.snapshot();
  }

  async idle(): Promise<void> { await Promise.all([...this.#tasks]); }

  async close(): Promise<void> {
    if (this.#session.status !== 'Completed' && this.#session.status !== 'Stopped') this.stop('ServerShutdown');
    await this.idle();
  }

  #current(session: GameSession, operation: Operation): boolean {
    return session === this.#session && session.operation === operation && !operation.controller.signal.aborted;
  }

  #launch(session: GameSession, single: boolean): Promise<void> {
    const operation: Operation = { controller: new AbortController(), single, attempt: null, attemptStarted: 0, delay: null };
    session.operation = operation;
    const task = this.#drive(session, operation).catch(() => {
      // An internal failure must not be recorded as a model's chess defeat.
      if (this.#current(session, operation)) this.stop('InternalError');
    }).finally(() => {
      if (session.operation === operation) {
        session.operation = null;
        this.#emit(session, 'OperationSettled');
      }
      this.#tasks.delete(task);
    });
    this.#tasks.add(task);
    return task;
  }

  #complete(session: GameSession, result: MatchResult): void {
    session.status = 'Completed';
    session.result = result;
    this.#emit(session, 'GameCompleted', { result });
  }

  #checkCompletion(session: GameSession): boolean {
    const outcome = session.engine.outcome();
    if (outcome) this.#complete(session, outcome);
    else if (session.engine.ply >= this.#config.maxPlies) this.#complete(session, { kind: 'Limit', reason: 'MaxPlies', score: '*', winner: null });
    return session.status === 'Completed';
  }

  #technicalLoss(session: GameSession, loser: Color, reason: MoveError['code']): void {
    const winner = loser === 'white' ? 'black' : 'white';
    this.#complete(session, { kind: 'TechnicalLoss', reason, loser, winner, score: winner === 'white' ? '1-0' : '0-1' });
  }

  async #preflight(session: GameSession, operation: Operation): Promise<boolean> {
    if (session.probed) return true;
    for (const color of ['white', 'black'] as const) {
      const player = session.players[color];
      try {
        const availability = await withDeadline(operation.controller.signal, player.config.timeoutMs, signal => player.provider.probe(player.config, signal));
        if (!this.#current(session, operation)) return false;
        if (!availability.available) throw new MoveResponseError('ProviderError', 'Model is unavailable');
        if ((player.config.temperature !== undefined && !availability.capabilities.temperature) ||
            (player.config.maxOutputTokens !== undefined && !availability.capabilities.maxOutputTokens)) {
          throw new MoveResponseError('ProviderError', 'Requested generation parameters are unsupported');
        }
        session.providerChecks.push({ color, checkedAt: new Date().toISOString(), result: {
          available: true, diagnostic: availability.diagnostic ?? 'Model is available', error: null, metrics: availability.metrics ?? requestMetrics(),
        } });
      } catch (error) {
        if (!this.#current(session, operation)) return false;
        const code = error instanceof MoveResponseError ? error.code : 'ProviderError';
        const message = error instanceof MoveResponseError ? error.message : 'Model preflight failed';
        session.providerChecks.push({ color, checkedAt: new Date().toISOString(), result: {
          available: false, diagnostic: message, error: { code, message }, metrics: error instanceof ProviderRequestError ? error.metrics : requestMetrics(),
        } });
        this.#emit(session, 'ProviderFailed', { color, message: `Model preflight failed (${code}): ${message}` });
        this.#technicalLoss(session, color, code);
        return false;
      }
    }
    session.probed = true;
    return true;
  }

  async #drive(session: GameSession, operation: Operation): Promise<void> {
    if (this.#checkCompletion(session) || !await this.#preflight(session, operation)) return;
    while (this.#current(session, operation) && (operation.single || session.status === 'Running')) {
      await this.#oneMove(session, operation);
      if (!this.#current(session, operation) || operation.single || session.status !== 'Running') break;
      // Fast mocks must still allow incoming Pause/Stop HTTP requests to run.
      await yieldToIo();
      if (this.#config.moveDelayMs && this.#current(session, operation) && session.status === 'Running') {
        const pause = new AbortController();
        operation.delay = pause;
        try {
          await delay(this.#config.moveDelayMs, undefined, { signal: AbortSignal.any([operation.controller.signal, pause.signal]) });
        } catch (error) { if (!pause.signal.aborted) throw error; }
        finally { operation.delay = null; }
      }
    }
  }

  #finishAttempt(operation: Operation, status: Attempt['status']): void {
    if (!operation.attempt) return;
    operation.attempt.status = status;
    operation.attempt.finishedAt = new Date().toISOString();
    operation.attempt.elapsedMs = performance.now() - operation.attemptStarted;
  }

  async #oneMove(session: GameSession, operation: Operation): Promise<void> {
    const color = session.engine.turn;
    const player = session.players[color];
    session.turn ??= { attempts: 0 };
    const turn = session.turn;
    while (this.#current(session, operation)) {
      const attempt: Attempt = {
        id: ++this.#attemptSequence, gameId: session.gameId, color, modelId: player.config.modelId,
        ply: session.engine.ply + 1, attemptNumber: ++turn.attempts, status: 'Pending',
        startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null,
        request: buildMoveRequest(session.engine, color, this.#config, turn.feedback),
        rawText: null, move: null, error: null,
        metrics: requestMetrics(),
      };
      operation.attempt = attempt;
      operation.attemptStarted = performance.now();
      session.attempts.push(attempt);
      this.#emit(session, 'MoveRequested', { attempt });
      try {
        const response = await withDeadline(operation.controller.signal, player.config.timeoutMs,
          signal => player.provider.complete(player.config, structuredClone(attempt.request), signal)).catch(error => {
          if (error instanceof MoveResponseError || !this.#current(session, operation)) throw error;
          throw new MoveResponseError('ProviderError', 'Provider request failed');
        });
        if (!this.#current(session, operation)) return;
        if (typeof response.rawText !== 'string') throw new MoveResponseError('ProviderError', 'Provider response must contain raw text');
        attempt.rawText = response.rawText;
        attempt.metrics = requestMetrics(response);
        if (response.diagnostics) attempt.diagnostics = structuredClone(response.diagnostics);
        attempt.move = parseMoveResponse(response.rawText);
        const move = session.engine.applyMove(attempt.move);
        this.#finishAttempt(operation, 'Accepted');
        operation.attempt = null;
        session.turn = null;
        this.#emit(session, 'MoveAccepted', { attempt, move });
        this.#checkCompletion(session);
        return;
      } catch (error) {
        if (!this.#current(session, operation)) return;
        if (!(error instanceof MoveResponseError) && !(error instanceof IllegalMoveError)) throw error;
        const failure: MoveError = error instanceof MoveResponseError ? { code: error.code, message: error.message }
          : { code: 'IllegalMove', message: error.message };
        attempt.error = failure;
        if (error instanceof ProviderRequestError) {
          attempt.metrics = error.metrics;
          attempt.diagnostics = error.diagnostics;
        }
        this.#finishAttempt(operation, 'Rejected');
        operation.attempt = null;
        const event = failure.code === 'ProviderError' || failure.code === 'Timeout' ? 'ProviderFailed' : 'MoveRejected';
        this.#emit(session, event, { attempt });
        turn.feedback = failure;
        if (turn.attempts > this.#config.maxRetries) {
          this.#technicalLoss(session, color, failure.code);
          return;
        }
        // A paused automatic request does not start a retry. Resume/NextMove retains its budget.
        if (!operation.single && session.status !== 'Running') return;
      }
    }
  }
}
