import { Value } from '@sinclair/typebox/value';
import { CreateMatchSchema, type CreateMatchRequest, type MatchConfig, type PlayerSettings, type ProbeResult } from '../contracts/match.js';
import { ChessEngine } from '../domain/chess/engine.js';
import { MockLlmProvider } from '../llm/mock-provider.js';
import { ProviderCredentials, normalizeBaseUrl } from '../llm/credentials.js';
import { OpenAiCompatibleProvider } from '../llm/openai-compatible.js';
import { ProviderRequestError, requestMetrics } from '../llm/provider.js';
import { MoveResponseError } from './move-response.js';
import { GameOrchestrator, MatchCommandError, type PlayersFactory } from './game-orchestrator.js';
import { DEFAULT_SYSTEM_PROMPT, validatePromptTemplate } from './prompts.js';
import type { ExperimentStore } from '../experiments/store.js';
import { experiment } from '../experiments/record.js';

export function normalizeConfig(input: CreateMatchRequest = {}): MatchConfig {
  if (!Value.Check(CreateMatchSchema, input)) throw new MatchCommandError('InvalidRequest', 'Invalid match configuration', 400);
  const config: MatchConfig = {
    players: structuredClone(input.players ?? { white: { strategy: 'RandomLegalMove', seed: 1 }, black: { strategy: 'RandomLegalMove', seed: 2 } }),
    mode: input.mode ?? 'A', maxRetries: input.maxRetries ?? 2, maxPlies: input.maxPlies ?? 512,
    moveDelayMs: input.moveDelayMs ?? 0,
    systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
  try {
    validatePromptTemplate(config.systemPrompt);
    for (const settings of Object.values(config.players)) {
      if (settings.systemPrompt) validatePromptTemplate(settings.systemPrompt);
      if (settings.provider === 'openai-compatible') settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
    }
  } catch (error) { throw new MatchCommandError('InvalidRequest', (error as Error).message, 400); }
  for (const settings of Object.values(config.players)) {
    if (settings.provider !== 'openai-compatible' && settings.strategy === 'ScriptedMoves' && !settings.moves?.length) {
      throw new MatchCommandError('InvalidRequest', 'ScriptedMoves requires a nonempty moves array', 400);
    }
  }
  return structuredClone(config);
}

export const mockPlayersFactory: PlayersFactory = config => {
  const bind = (color: 'white' | 'black') => {
    const settings = config.players[color];
    if (settings.provider === 'openai-compatible') throw new Error('Mock factory requires Mock settings');
    return {
      provider: new MockLlmProvider(settings, fen => new ChessEngine(fen).legalMovesUci()),
      config: { provider: 'mock' as const, baseUrl: 'mock://local', modelId: `mock-${color}-${settings.strategy}`, timeoutMs: settings.timeoutMs ?? 1000 },
    };
  };
  return { white: bind('white'), black: bind('black') };
};

export function createPlayersFactory(credentials: ProviderCredentials): PlayersFactory {
  return config => {
    const bind = (color: 'white' | 'black') => {
      const settings = config.players[color];
      if (settings.provider !== 'openai-compatible') {
        return {
          provider: new MockLlmProvider(settings, fen => new ChessEngine(fen).legalMovesUci()),
          config: { provider: 'mock' as const, baseUrl: 'mock://local', modelId: `mock-${color}-${settings.strategy}`, timeoutMs: settings.timeoutMs ?? 1000 },
        };
      }
      try { credentials.resolve(settings.baseUrl, settings.credentialProfile); }
      catch { throw new MatchCommandError('InvalidRequest', 'Credential profile is unavailable or does not match Base URL', 400); }
      return { provider: new OpenAiCompatibleProvider(credentials), config: { ...settings } };
    };
    return { white: bind('white'), black: bind('black') };
  };
}

export class MatchService {
  readonly #matches = new Map<string, GameOrchestrator>();
  #closed = false;
  readonly #factory: PlayersFactory;
  readonly #probes = new Set<AbortController>();
  constructor(readonly credentials = new ProviderCredentials(), readonly store?: ExperimentStore) { this.#factory = createPlayersFactory(credentials); }
  async snapshot(id: string) {
    const live = this.#matches.get(id);
    if (live) return live.snapshot();
    if (this.store) {
      try { return { ...(await this.store.latest(id)).snapshot, archived: true }; }
      catch (error) { if (!(error instanceof Error && 'statusCode' in error && error.statusCode === 404)) throw error; }
    }
    throw new MatchCommandError('MatchNotFound', 'Match not found', 404);
  }
  async journal(id: string, after: number, limit: number) {
    const live = this.#matches.get(id);
    if (live) return live.events.read(after, limit);
    if (!this.store) throw new MatchCommandError('MatchNotFound', 'Match not found', 404);
    const record = await this.store.latest(id);
    const remaining = record.events.filter(event => event.sequence > after);
    return { events: remaining.slice(0, limit), lastSequence: record.snapshot.lastEventSequence, hasMore: remaining.length > limit };
  }
  findLive(id: string) { return this.#matches.get(id); }
  async flush() { await Promise.allSettled([...this.#matches.values()].map(match => match.persisted())); }
  info() { return { defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, profiles: this.credentials.list() }; }
  async probe(settings: PlayerSettings, signal: AbortSignal): Promise<ProbeResult> {
    if (this.#closed) throw new MatchCommandError('ServerStopping', 'The server is stopping', 503);
    const config = normalizeConfig({ players: { white: settings, black: { strategy: 'RandomLegalMove' } } });
    const binding = this.#factory(config).white;
    const controller = new AbortController();
    this.#probes.add(controller);
    try {
      const result = await binding.provider.probe(binding.config, AbortSignal.any([signal, controller.signal]));
      return { available: result.available, diagnostic: result.diagnostic ?? 'Model is available', error: null, metrics: result.metrics ?? requestMetrics(), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
    } catch (error) {
      const failure = error instanceof MoveResponseError ? { code: error.code, message: error.message }
        : { code: 'ProviderError' as const, message: 'Provider check failed or was cancelled' };
      return { available: false, diagnostic: failure.message, error: failure, metrics: error instanceof ProviderRequestError ? error.metrics : requestMetrics(), ...(error instanceof ProviderRequestError ? { diagnostics: error.diagnostics } : {}) };
    } finally { this.#probes.delete(controller); }
  }
  create(input: CreateMatchRequest = {}): GameOrchestrator {
    if (this.#closed) throw new MatchCommandError('ServerStopping', 'The server is stopping', 503);
    const match = new GameOrchestrator(normalizeConfig(input), this.#factory, undefined,
      this.store ? async (snapshot, events) => { await this.store!.save(experiment(snapshot, events)); } : undefined);
    this.#matches.set(match.id, match);
    return match;
  }
  get(id: string): GameOrchestrator {
    if (this.#closed) throw new MatchCommandError('ServerStopping', 'The server is stopping', 503);
    const match = this.#matches.get(id);
    if (!match) throw new MatchCommandError('MatchNotFound', 'Match not found', 404);
    return match;
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#probes) controller.abort();
    await Promise.all([...this.#matches.values()].map(match => match.close()));
  }
}
