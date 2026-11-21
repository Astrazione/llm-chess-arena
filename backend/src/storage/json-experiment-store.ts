import { open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { EventSchema, ExperimentSchema, SnapshotSchema, type Experiment } from '../contracts/match.js';
import { playerName } from '../experiments/record.js';
import { statistics } from '../experiments/statistics.js';
import { StorageError, type ExperimentStore } from '../experiments/store.js';
import { ChessEngine } from '../domain/chess/engine.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class JsonExperimentStore implements ExperimentStore {
  constructor(readonly directory: string, readonly redact: (text: string) => string = text => text) {}
  #sanitize(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.#sanitize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#sanitize(item)]));
    return value;
  }
  #path(id: string): string {
    if (!uuid.test(id)) throw new StorageError('ExperimentNotFound', 404);
    return join(this.directory, `${id}.json`);
  }
  async save(record: Experiment): Promise<void> {
    const target = this.#path(record.id);
    const temporary = join(this.directory, `.${record.id}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(this.#sanitize(record)), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, target);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new StorageError('StorageUnavailable', 503); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async get(id: string): Promise<Experiment> {
    const path = this.#path(id);
    let content: string;
    try { content = await readFile(path, 'utf8'); }
    catch (error) { throw new StorageError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ExperimentNotFound' : 'StorageUnavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 503); }
    try {
      const parsed = this.#sanitize(JSON.parse(content));
      if (!Value.Check(ExperimentSchema, [SnapshotSchema, EventSchema], parsed)) throw new Error();
      const record = parsed as Experiment;
      if (record.id !== id || record.snapshot.gameId !== id || record.snapshot.id !== record.matchId || record.events.some(event => event.gameId !== id || event.matchId !== record.matchId)) throw new Error();
      const { snapshot } = record;
      const positions = snapshot.position.positions;
      if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) ||
          positions.length !== snapshot.position.history.length + 1 || positions.at(-1) !== snapshot.position.fen ||
          snapshot.position.history.some((move, index) => move.ply !== index + 1 || move.before !== positions[index] || move.after !== positions[index + 1]) ||
          snapshot.attempts.some(attempt => attempt.gameId !== id) ||
          record.events.some((event, index) => event.sequence > snapshot.lastEventSequence || (index > 0 && event.sequence <= record.events[index - 1]!.sequence))) throw new Error();
      new ChessEngine(positions[0]); new ChessEngine(snapshot.position.fen);
      return record;
    } catch { throw new StorageError('CorruptExperiment', 422); }
  }
  async #ids(): Promise<string[]> {
    try { return (await readdir(this.directory)).filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5))).map(name => name.slice(0, -5)); }
    catch { throw new StorageError('StorageUnavailable', 503); }
  }
  async list(offset = 0, limit = 100) {
    const records: Experiment[] = [];
    let unreadableFiles = 0;
    for (const id of await this.#ids()) {
      try { records.push(await this.get(id)); }
      catch (error) { if (error instanceof StorageError && error.code === 'CorruptExperiment') unreadableFiles++; else throw error; }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { unreadableFiles, total: records.length, experiments: records.slice(offset, offset + limit).map(record => ({
      id: record.id, matchId: record.matchId, createdAt: record.createdAt, updatedAt: record.updatedAt,
      status: record.snapshot.status, result: record.snapshot.result, statistics: record.statistics,
      players: { white: playerName(record.snapshot.config.players.white), black: playerName(record.snapshot.config.players.black) },
    })) };
  }
  async latest(matchId: string): Promise<Experiment> {
    const candidates: Experiment[] = [];
    for (const id of await this.#ids()) {
      try { const record = await this.get(id); if (record.matchId === matchId) candidates.push(record); }
      catch (error) { if (!(error instanceof StorageError && error.code === 'CorruptExperiment')) throw error; }
    }
    candidates.sort((a, b) => b.snapshot.generation - a.snapshot.generation);
    if (!candidates[0]) throw new StorageError('ExperimentNotFound', 404);
    return candidates[0];
  }
  #removable(record: Experiment, protectedIds: ReadonlySet<string>): boolean {
    return !protectedIds.has(record.id) && !record.snapshot.busy && record.snapshot.result !== null &&
      (record.snapshot.status === 'Completed' || record.snapshot.status === 'Stopped');
  }
  async cleanupCandidates(protectedIds: ReadonlySet<string>): Promise<string[]> {
    const ids: string[] = [];
    for (const id of await this.#ids()) {
      try { if (this.#removable(await this.get(id), protectedIds)) ids.push(id); }
      catch (error) {
        if (!(error instanceof StorageError && (error.code === 'CorruptExperiment' || error.code === 'ExperimentNotFound'))) throw error;
      }
    }
    return ids;
  }
  async removeCompleted(ids: readonly string[], protectedIds: ReadonlySet<string>) {
    const result = { deleted: 0, skipped: 0, failed: 0 };
    // Delete only the explicitly confirmed IDs; new terminal games await another confirmation.
    for (const id of new Set(ids)) {
      try {
        if (!this.#removable(await this.get(id), protectedIds)) { result.skipped++; continue; }
        await unlink(this.#path(id));
        result.deleted++;
      } catch (error) {
        if ((error instanceof StorageError && (error.code === 'CorruptExperiment' || error.code === 'ExperimentNotFound')) ||
            (error as NodeJS.ErrnoException).code === 'ENOENT') result.skipped++;
        else result.failed++;
      }
    }
    if (result.deleted) {
      try {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { throw new StorageError('StorageUnavailable', 503); }
    }
    return result;
  }
  async recover(): Promise<void> {
    for (const id of await this.#ids()) {
      let record: Experiment;
      try { record = await this.get(id); }
      catch (error) { if (error instanceof StorageError && error.code === 'CorruptExperiment') continue; throw error; }
      const snapshot = record.snapshot;
      if (snapshot.result && !snapshot.busy) continue;
      const at = new Date().toISOString();
      if (!snapshot.result) {
        snapshot.status = 'Stopped';
        snapshot.result = { kind: 'Stopped', reason: 'ServerShutdown', score: '*', winner: null };
      }
      snapshot.busy = false;
      const append = (type: 'AttemptCancelled' | 'GameStopped', data: Experiment['events'][number]['data']) => {
        record.events.push({ schemaVersion: 1, matchId: record.matchId, gameId: id, sequence: ++snapshot.lastEventSequence, at,
          type, status: snapshot.status, ply: snapshot.position.history.length, fen: snapshot.position.fen, data });
      };
      for (const attempt of snapshot.attempts) if (attempt.status === 'Pending') {
        attempt.status = 'Cancelled'; // Unknown completion time/usage remains null after a crash.
        append('AttemptCancelled', { attempt: structuredClone(attempt), message: 'Recovered after backend interruption' });
      }
      if (snapshot.result.kind === 'Stopped') append('GameStopped', { result: snapshot.result });
      record.recoveredAt = at; record.updatedAt = at;
      record.statistics = statistics(snapshot, record.events); snapshot.statistics = record.statistics;
      record.statistics.durationMs = null; // The actual interruption time is unknown.
      await this.save(record);
    }
  }
}
