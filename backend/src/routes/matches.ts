import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ApiErrorSchema, CreateMatchSchema, DrawClaimSchema, EventSchema, SnapshotSchema, PlayerSettingsSchema, ProbeResultSchema, ProviderInfoSchema, type PlayerSettings, type CreateMatchRequest, type MatchSnapshot, type StreamUpdate } from '../contracts/match.js';
import { MatchCommandError } from '../application/game-orchestrator.js';
import type { MatchService } from '../application/match-service.js';

const ParamsSchema = Type.Object({ matchId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
type MatchParams = Static<typeof ParamsSchema>;
const QuerySchema = Type.Object({
  after: Type.Optional(Type.String({ pattern: '^[0-9]+$', maxLength: 15 })),
  limit: Type.Optional(Type.String({ pattern: '^[0-9]+$', maxLength: 3 })),
}, { additionalProperties: false });
const ClaimSchema = Type.Object({ reason: DrawClaimSchema }, { additionalProperties: false });
const commonResponses = { 400: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 500: ApiErrorSchema, 503: ApiErrorSchema };

export function registerMatchRoutes(app: FastifyInstance, service: MatchService): void {
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.addSchema(SnapshotSchema);
  app.addSchema(EventSchema);

  app.get('/api/providers', { schema: { response: { 200: ProviderInfoSchema } } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.info();
  });
  app.post<{ Body: PlayerSettings }>('/api/providers/probe', {
    schema: { body: PlayerSettingsSchema, response: { 200: ProbeResultSchema, ...commonResponses } },
  }, async (request, reply) => {
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    try { return await service.probe(request.body, controller.signal); }
    finally { reply.raw.removeListener('close', onClose); }
  });

  // Notifications carry an authoritative snapshot. Missed journal entries are
  // recovered with the paginated REST endpoint, rather than an unbounded replay.
  app.get<{ Params: MatchParams }>('/api/matches/:matchId/stream', {
    schema: { params: ParamsSchema, response: commonResponses },
  }, async (request, reply) => {
    const initial = await service.snapshot(request.params.matchId);
    const match = service.findLive(request.params.matchId);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      reply.raw.end();
    };
    const send = (frame: string) => {
      // A normal snapshot can exceed Node's highWaterMark. A false write alone
      // must not disconnect it. Bound accumulated output for genuinely slow
      // consumers; EventSource + REST recovers after that disconnect.
      if (closed) return;
      if (reply.raw.writableLength > 8 * 1024 * 1024) { close(); return; }
      reply.raw.write(frame);
    };
    const unsubscribe = match?.events.subscribe(event => {
      const update: StreamUpdate = { schemaVersion: 1, event, snapshot: match.snapshot() };
      send(`id: ${event.sequence}\nevent: match\ndata: ${JSON.stringify(update)}\n\n`);
    }) ?? (() => {});
    const heartbeat = setInterval(() => { send(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    streams.add(close);
    reply.raw.on('close', close);
    send(`retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
  });

  app.post<{ Body: CreateMatchRequest; Reply: MatchSnapshot }>('/api/matches', {
    schema: { body: CreateMatchSchema, response: { 201: Type.Ref(SnapshotSchema), ...commonResponses } },
  }, async (request, reply) => {
    const match = service.create(request.body);
    await match.persisted();
    reply.code(201).header('Location', `/api/matches/${match.id}`);
    return match.snapshot();
  });

  app.get<{ Params: MatchParams; Reply: MatchSnapshot }>('/api/matches/:matchId', {
    schema: { params: ParamsSchema, response: { 200: Type.Ref(SnapshotSchema), ...commonResponses } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.snapshot(request.params.matchId);
  });

  const commands = ['start', 'pause', 'resume', 'next-move', 'stop', 'reset'] as const;
  for (const command of commands) {
    const statusCode = command === 'start' || command === 'resume' ? 202 : 200;
    app.post<{ Params: MatchParams; Reply: MatchSnapshot }>(`/api/matches/:matchId/${command}`, {
      schema: { params: ParamsSchema, response: { [statusCode]: Type.Ref(SnapshotSchema), ...commonResponses } },
      preValidation: async request => {
        if (request.body !== undefined && (
          typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length !== 0
        )) throw new MatchCommandError('InvalidRequest', 'This command accepts no arguments', 400);
      },
    }, async (request, reply) => {
      const match = service.get(request.params.matchId);
      const result = command === 'next-move' ? await match.nextMove() : match[command]();
      await match.persisted();
      reply.code(statusCode);
      return result;
    });
  }

  app.post<{ Params: MatchParams; Body: Static<typeof ClaimSchema>; Reply: MatchSnapshot }>('/api/matches/:matchId/claim-draw', {
    schema: { params: ParamsSchema, body: ClaimSchema, response: { 200: Type.Ref(SnapshotSchema), ...commonResponses } },
  }, async request => {
    const match = service.get(request.params.matchId);
    const result = match.claimDraw(request.body.reason);
    await match.persisted();
    return result;
  });

  app.get<{ Params: MatchParams; Querystring: Static<typeof QuerySchema> }>('/api/matches/:matchId/events', {
    schema: {
      params: ParamsSchema, querystring: QuerySchema,
      response: {
        200: Type.Object({
          schemaVersion: Type.Literal(1), matchId: Type.String(),
          events: Type.Array(Type.Ref(EventSchema)), lastSequence: Type.Integer(), hasMore: Type.Boolean(),
        }, { additionalProperties: false }),
        ...commonResponses,
      },
    },
  }, async (request, reply) => {
    const after = Number(request.query.after ?? 0);
    const limit = Number(request.query.limit ?? 100);
    if (limit < 1 || limit > 500) throw new MatchCommandError('InvalidRequest', 'limit must be between 1 and 500', 400);
    reply.header('Cache-Control', 'no-store');
    return { schemaVersion: 1, matchId: request.params.matchId, ...await service.journal(request.params.matchId, after, limit) };
  });
}
