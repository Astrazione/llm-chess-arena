import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ApiErrorSchema, ExperimentListSchema, ExperimentSchema, SnapshotSchema, HistoryCleanupRequestSchema, HistoryCleanupPreviewSchema, HistoryCleanupResultSchema } from '../contracts/match.js';
import type { MatchService } from '../application/match-service.js';
import type { ExperimentStore } from '../experiments/store.js';
import { exportPgn } from '../experiments/record.js';
import { MatchCommandError } from '../application/game-orchestrator.js';
import { StorageError } from '../experiments/store.js';

const Params = Type.Object({ gameId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
const errors = { 400: ApiErrorSchema, 404: ApiErrorSchema, 422: ApiErrorSchema, 503: ApiErrorSchema };
export function registerExperimentRoutes(app: FastifyInstance, matches: MatchService, store: ExperimentStore): void {
  app.get('/api/experiments/cleanup', {
    schema: { response: { 200: HistoryCleanupPreviewSchema, ...errors } },
  }, async (_request, reply) => {
    await matches.flush(); reply.header('Cache-Control', 'no-store');
    return { schemaVersion: 1, gameIds: await store.cleanupCandidates(matches.protectedGameIds()) };
  });
  app.delete<{ Body: Static<typeof HistoryCleanupRequestSchema> }>('/api/experiments', {
    schema: { body: HistoryCleanupRequestSchema, response: { 200: HistoryCleanupResultSchema, ...errors } },
  }, async (request, reply) => {
    await matches.flush(); reply.header('Cache-Control', 'no-store');
    return { schemaVersion: 1, ...await store.removeCompleted(request.body.gameIds, matches.protectedGameIds()) };
  });
  app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/experiments', {
    schema: { querystring: Type.Object({ offset: Type.Optional(Type.String({ pattern: '^[0-9]{1,8}$' })), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })) }, { additionalProperties: false }), response: { 200: ExperimentListSchema, ...errors } },
  }, async (request, reply) => {
    await matches.flush(); reply.header('Cache-Control', 'no-store');
    return store.list(Number(request.query.offset ?? 0), Number(request.query.limit ?? 50));
  });
  for (const suffix of ['', '/export.json', '/export.pgn'] as const) {
    app.get<{ Params: Static<typeof Params> }>(`/api/experiments/:gameId${suffix}`, {
      schema: { params: Params, response: { ...(suffix === '/export.pgn' ? { 200: Type.String() } : { 200: ExperimentSchema }), ...errors } },
    }, async (request, reply) => {
      await matches.flush();
      const record = await store.get(request.params.gameId);
      reply.header('Cache-Control', 'no-store');
      if (suffix) reply.header('Content-Disposition', `attachment; filename="${record.id}${suffix === '/export.pgn' ? '.pgn' : '.json'}"`);
      if (suffix === '/export.pgn') {
        let pgn: string;
        try { pgn = exportPgn(record); } catch { throw new StorageError('CorruptExperiment', 422); }
        return reply.type('application/x-chess-pgn; charset=utf-8').send(pgn);
      }
      return record;
    });
  }
  app.post<{ Params: Static<typeof Params> }>('/api/experiments/:gameId/replay', {
    schema: { params: Params, response: { 201: Type.Ref(SnapshotSchema), ...errors } },
    preValidation: async request => {
      if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length)) throw new MatchCommandError('InvalidRequest', 'This command accepts no arguments', 400);
    },
  }, async (request, reply) => {
    await matches.flush();
    const record = await store.get(request.params.gameId);
    const match = matches.create(record.snapshot.config);
    await match.persisted();
    reply.code(201).header('Location', `/api/matches/${match.id}`);
    return match.snapshot();
  });
}
