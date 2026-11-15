import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'service'],
          properties: {
            status: { type: 'string', const: 'ok' },
            service: { type: 'string', const: 'backend' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'backend' };
  });
}
