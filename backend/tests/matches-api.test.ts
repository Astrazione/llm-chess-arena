import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POSITION } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { CreateMatchRequest, MatchSnapshot } from '../src/contracts/match.js';

describe('match REST API', () => {
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'arena-api-'));
    app = buildApp(loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }));
  });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function create(config: CreateMatchRequest = {}) {
    const response = await app.inject({ method: 'POST', url: '/api/matches', payload: config });
    expect(response.statusCode).toBe(201);
    const body = response.json<MatchSnapshot>();
    expect(response.headers.location).toBe(`/api/matches/${body.id}`);
    return body;
  }
  const command = (id: string, action: string) => app.inject({ method: 'POST', url: `/api/matches/${id}/${action}` });
  const snapshot = async (id: string) => (await app.inject(`/api/matches/${id}`)).json<MatchSnapshot>();

  it('creates, steps, reads events, stops idempotently and resets a match', async () => {
    const created = await create();
    expect(created).toMatchObject({ schemaVersion: 1, status: 'Created', busy: false, position: { fen: DEFAULT_POSITION } });
    expect((await command(created.id, 'pause')).statusCode).toBe(409);
    const stepped = await command(created.id, 'next-move');
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json<MatchSnapshot>().position.history).toHaveLength(1);
    expect((await snapshot(created.id)).status).toBe('Paused');
    const events = await app.inject(`/api/matches/${created.id}/events?after=1&limit=2`);
    expect(events.statusCode).toBe(200);
    expect(events.json().events.map((event: { sequence: number }) => event.sequence)).toEqual([2, 3]);
    expect(events.json().hasMore).toBe(true);
    const stopped = await command(created.id, 'stop');
    expect(stopped.json().result).toMatchObject({ kind: 'Stopped', score: '*', winner: null });
    expect((await command(created.id, 'stop')).json()).toEqual(stopped.json());
    expect((await command(created.id, 'resume')).json().error.code).toBe('InvalidTransition');
    const reset = (await command(created.id, 'reset')).json<MatchSnapshot>();
    expect(reset.id).toBe(created.id);
    expect(reset.gameId).not.toBe(created.gameId);
    expect(reset).toMatchObject({ generation: 2, status: 'Created', position: { fen: DEFAULT_POSITION, history: [] }, attempts: [] });
  });

  it.each([
    { extra: true }, { maxRetries: '2' }, { maxRetries: 11 }, { maxPlies: 0 }, { mode: 'C' },
    { players: { white: { strategy: 'RandomLegalMove' } } },
    { players: { white: { strategy: 'Unknown' }, black: { strategy: 'RandomLegalMove' } } },
    { players: { white: { strategy: 'ScriptedMoves' }, black: { strategy: 'RandomLegalMove' } } },
  ])('rejects invalid configuration without coercing or dropping fields: %j', async payload => {
    const response = await app.inject({ method: 'POST', url: '/api/matches', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('InvalidRequest');
  });

  it('returns explicit errors for missing matches, malformed IDs, command bodies and pagination', async () => {
    const missing = await app.inject('/api/matches/00000000-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('MatchNotFound');
    expect((await app.inject('/api/matches/invalid')).statusCode).toBe(400);
    const created = await create();
    expect((await app.inject(`/api/matches/${created.id}/events?limit=0`)).statusCode).toBe(400);
    expect((await app.inject(`/api/matches/${created.id}/events?after=-1`)).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/matches/${created.id}/start`, payload: { force: true } })).statusCode).toBe(400);
  });

  it('plays a complete scripted game through Start and polling', async () => {
    const created = await create({ players: {
      white: { strategy: 'ScriptedMoves', moves: ['f2f3', 'g2g4'] },
      black: { strategy: 'ScriptedMoves', moves: ['e7e5', 'd8h4'] },
    } });
    expect((await command(created.id, 'start')).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await snapshot(created.id)).status).toBe('Completed'));
    const result = await snapshot(created.id);
    expect(result.position.history).toHaveLength(4);
    expect(result.result).toMatchObject({ kind: 'Chess', reason: 'Checkmate', winner: 'black', score: '0-1' });
    expect((await command(created.id, 'stop')).statusCode).toBe(409);
    expect((await snapshot(created.id)).result).toEqual(result.result);
  });

  it('supports pause/resume and idempotent running commands', async () => {
    const created = await create({ maxPlies: 2, players: {
      white: { strategy: 'DelayedResponse', delayMs: 40 }, black: { strategy: 'DelayedResponse', delayMs: 40 },
    } });
    expect((await command(created.id, 'start')).statusCode).toBe(202);
    expect((await command(created.id, 'start')).statusCode).toBe(202);
    expect((await command(created.id, 'pause')).statusCode).toBe(200);
    const events = (await snapshot(created.id)).lastEventSequence;
    expect((await command(created.id, 'pause')).json().lastEventSequence).toBe(events);
    await vi.waitFor(async () => expect((await snapshot(created.id)).busy).toBe(false));
    expect((await snapshot(created.id)).status).toBe('Paused');
    expect((await command(created.id, 'resume')).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await snapshot(created.id)).status).toBe('Completed'));
    expect((await snapshot(created.id)).position.history).toHaveLength(2);
  });

  it('rejects simultaneous NextMove and cancels an in-flight request on Reset', async () => {
    const created = await create({ players: {
      white: { strategy: 'DelayedResponse', delayMs: 1000, timeoutMs: 5000 }, black: { strategy: 'RandomLegalMove' },
    } });
    const pending = command(created.id, 'next-move').then(response => response);
    await vi.waitFor(async () => expect((await snapshot(created.id)).attempts).toHaveLength(1));
    const conflict = await command(created.id, 'next-move');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('OperationInProgress');
    expect((await command(created.id, 'reset')).json().status).toBe('Created');
    expect((await pending).json().error.code).toBe('SessionChanged');
    expect((await snapshot(created.id)).position.fen).toBe(DEFAULT_POSITION);
  });

  it('rejects draw claims that are not justified', async () => {
    const created = await create();
    const response = await app.inject({ method: 'POST', url: `/api/matches/${created.id}/claim-draw`, payload: { reason: 'FiftyMoves' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DrawNotClaimable');
  });

  it('closes without waiting for a long-running NextMove timeout', async () => {
    const created = await create({ players: {
      white: { strategy: 'DelayedResponse', delayMs: 60000, timeoutMs: 30000 }, black: { strategy: 'RandomLegalMove' },
    } });
    const pending = command(created.id, 'next-move').then(response => response);
    await vi.waitFor(async () => expect((await snapshot(created.id)).attempts).toHaveLength(1));
    await app.close();
    expect((await pending).json()).toMatchObject({ status: 'Stopped', result: { kind: 'Stopped', reason: 'ServerShutdown' } });
  });
});
