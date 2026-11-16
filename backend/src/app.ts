import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import Fastify, { type FastifyError } from 'fastify';
import type { AppConfig } from './config.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMatchRoutes } from './routes/matches.js';
import { MatchService } from './application/match-service.js';
import { MatchCommandError } from './application/game-orchestrator.js';

export function buildApp(config: AppConfig, matches = new MatchService()) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // Fail before accepting traffic if the experiment volume is not writable.
  app.addHook('onReady', async () => {
    await mkdir(config.dataDir, { recursive: true });
    await access(config.dataDir, constants.R_OK | constants.W_OK);
  });
  registerHealthRoute(app);
  registerMatchRoutes(app, matches);
  // Cancel moves before waiting for in-flight NextMove HTTP handlers to close.
  app.addHook('preClose', async () => { await matches.close(); });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof MatchCommandError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error.validation || (error.statusCode !== undefined && error.statusCode < 500)) {
      return reply.code(400).send({ error: { code: 'InvalidRequest', message: 'Request does not match the API schema' } });
    }
    app.log.error(error, 'Request failed');
    return reply.code(500).send({ error: { code: 'InternalError', message: 'Internal server error' } });
  });
  return app;
}
