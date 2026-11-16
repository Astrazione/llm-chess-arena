import type { FastifyInstance } from 'fastify';
import { ApiErrorSchema, ModelConnectionSchema, ModelListSchema, type ModelConnection } from '../contracts/match.js';
import { DiscoveryError, type ModelDiscovery } from '../llm/model-discovery.js';

export function registerModelRoutes(app: FastifyInstance, discovery: ModelDiscovery): void {
  const active = new Set<AbortController>();
  let closed = false;
  app.addHook('preClose', async () => { closed = true; for (const controller of active) controller.abort(); });
  app.post<{ Body: ModelConnection }>('/api/providers/models', {
    bodyLimit: 4096,
    schema: { body: ModelConnectionSchema, response: { 200: ModelListSchema, ...Object.fromEntries([400, 403, 429, 502, 503, 504].map(code => [code, ApiErrorSchema])) } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // The local application has no remote authentication. Prevent cross-site browser use.
    if (request.headers.origin) {
      let host: string;
      try { host = new URL(request.headers.origin).host; } catch { host = ''; }
      if (!host || host !== request.headers.host) return reply.code(403).send({ error: { code: 'ForbiddenOrigin', message: 'Cross-origin discovery is not allowed' } });
    }
    if (closed) return reply.code(503).send({ error: { code: 'ServerStopping', message: 'Server is stopping' } });
    if (active.size >= 4) return reply.code(429).send({ error: { code: 'DiscoveryBusy', message: 'Слишком много запросов списка моделей. Повторите позже.' } });
    const controller = new AbortController();
    active.add(controller);
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    try { return await discovery.list(request.body, controller.signal); }
    catch (error) {
      const failure = error instanceof DiscoveryError ? error : new DiscoveryError('DiscoveryCancelled', 'Получение моделей отменено.', 503);
      return reply.code(failure.statusCode).send({ error: { code: failure.code, message: failure.message } });
    } finally { active.delete(controller); reply.raw.removeListener('close', onClose); }
  });
}
