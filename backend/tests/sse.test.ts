import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { MatchSnapshot, StreamUpdate } from '../src/contracts/match.js';

describe('SSE over real HTTP', () => {
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  let base: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'arena-sse-'));
    app = buildApp(loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }));
    base = await app.listen({ host: '0.0.0.0', port: 0 });
    base = base.replace('0.0.0.0', '127.0.0.1');
  });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function create() {
    return (await app.inject({ method: 'POST', url: '/api/matches', payload: { moveDelayMs: 60000 } })).json<MatchSnapshot>();
  }
  async function open(id: string) {
    const response = await fetch(`${base}/api/matches/${id}/stream`, { signal: AbortSignal.timeout(4000) });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      reader,
      async next() {
        while (!buffer.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream closed before frame');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const index = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        return { frame, data: JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as MatchSnapshot | StreamUpdate };
      },
    };
  }
  it('sends initial snapshot, ordered notifications, settled busy flag and a new game after Reset', async () => {
    const match = await create();
    const stream = await open(match.id);
    expect((await stream.next()).data).toMatchObject({ gameId: match.gameId, busy: false, schemaVersion: 1 });
    await app.inject({ method: 'POST', url: `/api/matches/${match.id}/next-move` });
    let lastSequence = 0;
    while (true) {
      const { frame, data } = await stream.next();
      const update = data as StreamUpdate;
      expect(frame).toContain(`id: ${update.event.sequence}`);
      expect(update.event.sequence).toBeGreaterThan(lastSequence);
      lastSequence = update.event.sequence;
      if (update.event.type === 'OperationSettled') {
        expect(update.snapshot).toMatchObject({ status: 'Paused', busy: false });
        expect(update.snapshot.position.history).toHaveLength(1);
        break;
      }
    }
    const reset = (await app.inject({ method: 'POST', url: `/api/matches/${match.id}/reset` })).json<MatchSnapshot>();
    while (true) {
      const update = (await stream.next()).data as StreamUpdate;
      if (update.event.type === 'GameReset') { expect(update.snapshot.gameId).toBe(reset.gameId); break; }
    }
    await stream.reader.cancel();
    const reconnected = await open(match.id);
    expect((await reconnected.next()).data).toMatchObject({ gameId: reset.gameId, status: 'Created' });
    await reconnected.reader.cancel();
  });
  it('Pause interrupts an inter-move delay and shutdown closes open streams', async () => {
    const match = await create();
    const stream = await open(match.id);
    await stream.next();
    await app.inject({ method: 'POST', url: `/api/matches/${match.id}/start` });
    while (true) {
      const update = (await stream.next()).data as StreamUpdate;
      if (update.event.type === 'MoveAccepted') break;
    }
    await app.inject({ method: 'POST', url: `/api/matches/${match.id}/pause` });
    while (true) {
      const update = (await stream.next()).data as StreamUpdate;
      if (update.event.type === 'OperationSettled') { expect(update.snapshot.busy).toBe(false); break; }
    }
    await app.close();
    expect((await stream.reader.read()).done).toBe(true);
  });
  it('keeps a stream open when a normal snapshot exceeds the socket highWaterMark', async () => {
    const match = await create();
    let snapshot = match;
    for (let index = 0; index < 50; index++) {
      snapshot = (await app.inject({ method: 'POST', url: `/api/matches/${match.id}/next-move` })).json<MatchSnapshot>();
    }
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(65536);
    const stream = await open(match.id);
    expect((await stream.next()).data).toMatchObject({ lastEventSequence: snapshot.lastEventSequence });
    await app.inject({ method: 'POST', url: `/api/matches/${match.id}/reset` });
    const update = (await stream.next()).data as StreamUpdate;
    expect(update.event.type).toBe('GameStopped');
    await stream.reader.cancel();
  });
});
