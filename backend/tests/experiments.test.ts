import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ProviderCredentials } from '../src/llm/credentials.js';
import { MatchService } from '../src/application/match-service.js';
import { JsonExperimentStore } from '../src/storage/json-experiment-store.js';
import { statistics } from '../src/experiments/statistics.js';
import type { CreateMatchRequest, Experiment, MatchSnapshot } from '../src/contracts/match.js';

describe('persistent experiments and exports', () => {
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  const restart = () => buildApp(loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }));
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'arena-store-')); app = restart(); });
  afterEach(async () => { await app.close().catch(() => {}); await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  async function create(config: CreateMatchRequest = {}) {
    const response = await app.inject({ method: 'POST', url: '/api/matches', payload: config });
    expect(response.statusCode).toBe(201);
    return response.json<MatchSnapshot>();
  }
  const command = (id: string, action: string) => app.inject({ method: 'POST', url: `/api/matches/${id}/${action}` });
  async function record(id: string) {
    const response = await app.inject(`/api/experiments/${id}`);
    expect(response.statusCode).toBe(200);
    return response.json<Experiment>();
  }

  it('clears confirmed terminal games, preserves active games, unrelated and corrupt files, and survives restart', async () => {
    const stopped = await create(); await command(stopped.id, 'stop');
    const completed = await create({ maxPlies: 1 }); await command(completed.id, 'next-move');
    const reset = await create(); const fresh = (await command(reset.id, 'reset')).json<MatchSnapshot>();
    const paused = await create(); await command(paused.id, 'next-move');
    const running = await create({ moveDelayMs: 60000 }); await command(running.id, 'start');
    const badId = '00000000-0000-4000-8000-000000000001';
    await writeFile(join(directory, `${badId}.json`), '{broken');
    await writeFile(join(directory, 'settings.json'), '{"preserve":true}');
    const preview = (await app.inject('/api/experiments/cleanup')).json();
    expect(preview.schemaVersion).toBe(1);
    expect(preview.gameIds.sort()).toEqual([stopped.gameId, completed.gameId, reset.gameId].sort());
    const response = await app.inject({ method: 'DELETE', url: '/api/experiments', payload: { gameIds: preview.gameIds } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, deleted: 3, skipped: 0, failed: 0 });
    for (const id of preview.gameIds) expect((await app.inject(`/api/experiments/${id}`)).statusCode).toBe(404);
    for (const id of [fresh.gameId, paused.gameId, running.gameId]) await record(id);
    expect(await readFile(join(directory, `${badId}.json`), 'utf8')).toBe('{broken');
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).toContain('preserve');
    await app.close(); app = restart();
    for (const id of preview.gameIds) expect((await app.inject(`/api/experiments/${id}`)).statusCode).toBe(404);
  });

  it('requires an explicit valid ID list and rechecks eligibility even for forged requests', async () => {
    const active = await create(); await command(active.id, 'next-move');
    for (const payload of [{}, { gameIds: ['../../settings'] }, { gameIds: [active.gameId], all: true }, { gameIds: [active.gameId, active.gameId] }]) {
      expect((await app.inject({ method: 'DELETE', url: '/api/experiments', payload })).statusCode).toBe(400);
    }
    const response = await app.inject({ method: 'DELETE', url: '/api/experiments', payload: { gameIds: [active.gameId] } });
    expect(response.json()).toMatchObject({ deleted: 0, skipped: 1, failed: 0 });
    expect((await record(active.gameId)).snapshot.status).toBe('Paused');
    expect((await app.inject({ method: 'DELETE', url: '/api/experiments', payload: { gameIds: [] } })).json()).toMatchObject({ deleted: 0 });
  });

  it('does not expand a confirmation when another game finishes, and repeated cleanup is idempotent', async () => {
    const old = await create(); await command(old.id, 'stop');
    const preview = (await app.inject('/api/experiments/cleanup')).json();
    const later = await create(); await command(later.id, 'stop');
    const clear = () => app.inject({ method: 'DELETE', url: '/api/experiments', payload: { gameIds: preview.gameIds } });
    expect((await clear()).json()).toMatchObject({ deleted: 1, skipped: 0 });
    expect((await clear()).json()).toMatchObject({ deleted: 0, skipped: 1 });
    await record(later.gameId);
  });

  it('reports real filesystem deletion failures without losing files', async () => {
    const match = await create(); await command(match.id, 'stop');
    await chmod(directory, 0o500);
    const response = await app.inject({ method: 'DELETE', url: '/api/experiments', payload: { gameIds: [match.gameId] } });
    expect(response.json()).toMatchObject({ deleted: 0, skipped: 0, failed: 1 });
    await record(match.gameId);
    await chmod(directory, 0o700);
  });

  it('persists a complete Mock game, exports standard PGN and reimports every position', async () => {
    const match = await create({ players: {
      white: { strategy: 'ScriptedMoves', moves: ['f2f3', 'g2g4'] }, black: { strategy: 'ScriptedMoves', moves: ['e7e5', 'd8h4'] },
    } });
    for (let i = 0; i < 4; i++) expect((await command(match.id, 'next-move')).statusCode).toBe(200);
    const saved = await record(match.gameId);
    expect(saved).toMatchObject({ schema: 'llm-chess-arena/experiment', schemaVersion: 1, statistics: { plies: 4, totalRequests: 4, resultCategory: 'ChessWin' } });
    expect(saved.snapshot.attempts).toHaveLength(4);
    expect(saved.events.some(event => event.type === 'GameCompleted')).toBe(true);
    const exported = await app.inject(`/api/experiments/${match.gameId}/export.pgn`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain(`${match.gameId}.pgn`);
    const chess = new Chess(); chess.loadPgn(exported.body);
    expect(chess.getHeaders()).toMatchObject({ White: 'Mock/ScriptedMoves', Black: 'Mock/ScriptedMoves', Result: '0-1', EndReason: 'Checkmate' });
    expect(chess.getHeaders().Date).toBe(saved.createdAt.slice(0, 10).replaceAll('-', '.'));
    expect(chess.history()).toEqual(saved.snapshot.position.history.map(move => move.san));
    expect(chess.history({ verbose: true }).map(move => move.after)).toEqual(saved.snapshot.position.positions.slice(1));
    expect(chess.fen()).toBe(saved.snapshot.position.fen);
    const json = await app.inject(`/api/experiments/${match.gameId}/export.json`);
    expect(json.json()).toEqual(saved);
    expect((await readdir(directory)).filter(file => file.endsWith('.tmp'))).toEqual([]);
    await app.close(); app = restart();
    expect((await record(match.gameId)).snapshot).toEqual(saved.snapshot);
    expect((await app.inject(`/api/matches/${match.id}`)).json()).toMatchObject({ archived: true, gameId: match.gameId });
  });

  it('keeps rejected responses and retry feedback, with no illegal moves in PGN', async () => {
    const match = await create({ players: { white: { strategy: 'ScriptedMoves', moves: ['e2e5', 'e2e4'] }, black: { strategy: 'RandomLegalMove' } } });
    await command(match.id, 'next-move');
    const saved = await record(match.gameId);
    expect(saved.statistics.players.white).toMatchObject({ successfulMoves: 1, illegalMoves: 1, errors: 1, retries: 1, legalMoveRatio: 0.5, inputTokens: null });
    expect(saved.snapshot.attempts[1]?.request.feedback?.code).toBe('IllegalMove');
    const pgn = (await app.inject(`/api/experiments/${match.gameId}/export.pgn`)).body;
    const chess = new Chess(); chess.loadPgn(pgn);
    expect(chess.history()).toEqual(['e4']); expect(pgn).not.toContain('e2e5');
  });

  it('exports a technical defeat with decisive score and explicit termination', async () => {
    const match = await create({ maxRetries: 1, players: { white: { strategy: 'MalformedResponse' }, black: { strategy: 'RandomLegalMove' } } });
    await command(match.id, 'next-move');
    expect((await record(match.gameId)).statistics).toMatchObject({ resultCategory: 'TechnicalLoss', players: { white: { formatErrors: 2, retries: 1, legalMoveRatio: 0 } } });
    const chess = new Chess(); chess.loadPgn((await app.inject(`/api/experiments/${match.gameId}/export.pgn`)).body);
    expect(chess.getHeaders()).toMatchObject({ Result: '0-1', Termination: 'rules infraction', EndReason: 'InvalidFormat' });
    expect(chess.history()).toHaveLength(0);
  });

  it('archives Reset under the old gameId and preserves global sequence', async () => {
    const match = await create({ players: { white: { strategy: 'DelayedResponse', delayMs: 1000, timeoutMs: 5000 }, black: { strategy: 'RandomLegalMove' } } });
    const pending = command(match.id, 'next-move').then(response => response);
    await vi.waitFor(async () => expect((await record(match.gameId)).snapshot.attempts[0]?.status).toBe('Pending'));
    const reset = (await command(match.id, 'reset')).json<MatchSnapshot>();
    expect((await pending).statusCode).toBe(409);
    const old = await record(match.gameId);
    expect(old.snapshot.result).toMatchObject({ kind: 'Stopped', reason: 'Reset' });
    expect(old.snapshot.attempts[0]?.status).toBe('Cancelled');
    expect((await record(reset.gameId)).events[0]?.sequence).toBeGreaterThan(old.snapshot.lastEventSequence);
    await app.close(); app = restart();
    expect((await app.inject(`/api/matches/${match.id}`)).json().gameId).toBe(reset.gameId);
    expect((await app.inject('/api/experiments')).json().total).toBe(2);
  });

  it('checkpoints before provider response and recovers unfinished work without retrying it', async () => {
    const match = await create();
    await command(match.id, 'next-move');
    await app.close();
    const store = new JsonExperimentStore(directory);
    const saved = await store.get(match.gameId);
    saved.snapshot.status = 'Running'; saved.snapshot.result = null; saved.snapshot.busy = true;
    saved.snapshot.attempts[0]!.status = 'Pending'; saved.snapshot.attempts[0]!.finishedAt = null;
    saved.snapshot.attempts[0]!.elapsedMs = null;
    await store.save(saved);
    app = restart();
    const recovered = await record(match.gameId);
    expect(recovered.recoveredAt).toBeDefined();
    expect(recovered.snapshot).toMatchObject({ status: 'Stopped', busy: false, result: { reason: 'ServerShutdown', score: '*' } });
    expect(recovered.snapshot.attempts[0]).toMatchObject({ status: 'Cancelled', finishedAt: null, elapsedMs: null });
    expect(recovered.statistics.durationMs).toBeNull();
    const before = recovered.events.length;
    await app.close(); app = restart();
    expect((await record(match.gameId)).events).toHaveLength(before);
  });

  it('keeps valid games accessible when another JSON is damaged or has an unknown version', async () => {
    const match = await create(); await command(match.id, 'stop');
    const badId = '00000000-0000-4000-8000-000000000001';
    await writeFile(join(directory, `${badId}.json`), '{broken');
    expect((await app.inject(`/api/experiments/${badId}`)).statusCode).toBe(422);
    await app.close(); app = restart();
    const list = (await app.inject('/api/experiments')).json();
    expect(list).toMatchObject({ unreadableFiles: 1, total: 1 });
    const saved = await record(match.gameId);
    const inconsistent = structuredClone(saved); inconsistent.snapshot.position.fen = 'invalid';
    await writeFile(join(directory, `${match.gameId}.json`), JSON.stringify(inconsistent));
    expect((await app.inject(`/api/experiments/${match.gameId}/export.pgn`)).statusCode).toBe(422);
    await writeFile(join(directory, `${match.gameId}.json`), JSON.stringify(saved));
    await writeFile(join(directory, `${badId}.json`), JSON.stringify({ ...saved, id: badId, schemaVersion: 99 }));
    expect((await app.inject(`/api/experiments/${badId}/export.json`)).statusCode).toBe(422);
    expect((await app.inject('/api/experiments?offset=0&limit=1')).json().experiments).toHaveLength(1);
    expect((await app.inject('/api/experiments?limit=0')).statusCode).toBe(400);
  });

  it('preserves the last valid JSON and stops the game on a real filesystem write failure', async () => {
    const match = await create();
    const before = await readFile(join(directory, `${match.gameId}.json`), 'utf8');
    await chmod(directory, 0o500);
    const result = await command(match.id, 'next-move');
    expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe('StorageUnavailable');
    expect(await readFile(join(directory, `${match.gameId}.json`), 'utf8')).toBe(before);
    const snapshot = (await app.inject(`/api/matches/${match.id}`)).json<MatchSnapshot>();
    expect(snapshot.storageError).toBeDefined(); expect(snapshot.position.history).toHaveLength(0);
    expect(snapshot.result).toMatchObject({ kind: 'Stopped', reason: 'InternalError' });
    await chmod(directory, 0o700);
    expect((await app.inject(`/api/experiments/${match.gameId}/export.json`)).statusCode).toBe(200);
  });

  it('creates a fresh experiment from the saved configuration without starting providers', async () => {
    const match = await create({ mode: 'B', players: { white: { strategy: 'RandomLegalMove', seed: 123 }, black: { strategy: 'RandomLegalMove', seed: 456 } } });
    await command(match.id, 'next-move');
    const response = await app.inject({ method: 'POST', url: `/api/experiments/${match.gameId}/replay` });
    expect(response.statusCode).toBe(201);
    const fresh = response.json<MatchSnapshot>();
    expect(fresh.config).toEqual(match.config); expect(fresh.id).not.toBe(match.id); expect(fresh.gameId).not.toBe(match.gameId);
    expect(fresh.status).toBe('Created'); expect(fresh.attempts).toHaveLength(0);
    expect((await record(match.gameId)).snapshot.position.history).toHaveLength(1);
  });

  it('handles unknown, partial and zero usage plus odd/even latency medians', async () => {
    const match = await create();
    expect(statistics(match, []).players.white).toMatchObject({ legalMoveRatio: null, meanResponseMs: null, medianResponseMs: null, inputTokens: null });
    const stepped = (await command(match.id, 'next-move')).json<MatchSnapshot>();
    const attempt = stepped.attempts[0]!;
    stepped.attempts = [10, 30, 20, 40].map((time, index) => ({ ...attempt, id: index, metrics: { responseTimeMs: time, inputTokens: index ? null : 0, outputTokens: index === 1 ? 5 : null, totalTokens: null, modelLoadTimeMs: null, generationTimeMs: null } }));
    expect(statistics(stepped, []).players.white).toMatchObject({ meanResponseMs: 25, medianResponseMs: 25, inputTokens: 0, inputTokenSamples: 1, outputTokens: 5 });
    stepped.attempts.pop(); expect(statistics(stepped, []).players.white.medianResponseMs).toBe(20);
  });

  it('stores seed, runtime metadata and complete preflight logs while redacting server secrets', async () => {
    const key = 'test-secret-quote-"-value';
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') { response.end('{"data":[]}'); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ model: key, choices: [{ message: { content: '{"move":"e2e4"}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const credentials = new ProviderCredentials({ KEY: key, LLM_ENDPOINTS_JSON: JSON.stringify({ local: { baseUrl, apiKeyEnv: 'KEY' } }) });
    await app.close();
    const store = new JsonExperimentStore(directory, text => credentials.redact(text));
    app = buildApp(loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }), new MatchService(credentials, store));
    try {
      const match = await create({ players: { white: { provider: 'openai-compatible', providerName: 'Local', baseUrl, modelId: 'model', credentialProfile: 'local', seed: 42, runtime: 'test', runtimeVersion: '1', quantization: '4bit', modelRevision: 'abc', maxContextTokens: 4096, timeoutMs: 1000, tokenLimitParameter: 'max_tokens', responseFormat: 'text' }, black: { strategy: 'RandomLegalMove' } } });
      await command(match.id, 'next-move');
      const saved = await record(match.gameId);
      expect(saved.snapshot.providerChecks[0]).toMatchObject({ request: { userPrompt: expect.stringContaining('Connection check') }, rawText: '{"move":"e2e4"}' });
      expect(saved.snapshot.config.players.white).toMatchObject({ seed: 42, runtimeVersion: '1', quantization: '4bit', modelRevision: 'abc' });
      expect(requests).toHaveLength(2); expect(requests.every(item => item.seed === 42)).toBe(true);
      expect(saved.statistics).toMatchObject({ totalRequests: 2, preflightRequests: 1, players: { white: { inputTokens: 4, outputTokens: 2 } } });
      const json = (await app.inject(`/api/experiments/${match.gameId}/export.json`)).body;
      expect(json).not.toContain(key); expect(json).not.toContain('Authorization'); expect(json).not.toContain('apiKeyEnv');
      const disk = await store.get(match.gameId); disk.snapshot.config.systemPrompt = `Bearer arbitrary-secret ${key}`;
      await store.save(disk);
      const stored = await readFile(join(directory, `${match.gameId}.json`), 'utf8');
      expect(stored).not.toContain('arbitrary-secret'); expect(stored).not.toContain('test-secret-quote');
    } finally { server.close(); server.closeAllConnections(); }
  });
});
