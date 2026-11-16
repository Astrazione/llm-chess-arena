import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import Fastify, { type FastifyError } from 'fastify';
import type { AppConfig } from './config.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMatchRoutes } from './routes/matches.js';
import { MatchService } from './application/match-service.js';
import { MatchCommandError } from './application/game-orchestrator.js';
import { ProviderCredentials } from './llm/credentials.js';
import { JsonExperimentStore } from './storage/json-experiment-store.js';
import { StorageError } from './experiments/store.js';
import { registerExperimentRoutes } from './routes/experiments.js';
import { registerModelRoutes } from './routes/models.js';
import { HttpModelDiscovery, type ModelDiscovery } from './llm/model-discovery.js';

export function buildApp(config: AppConfig, matches?: MatchService, discovery?: ModelDiscovery) {
  const credentials = matches?.credentials ?? new ProviderCredentials();
  const store = matches?.store ?? new JsonExperimentStore(config.dataDir, text => credentials.redact(text));
  const service = matches ?? new MatchService(credentials, store);
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
    await store.recover();
  });
  registerHealthRoute(app);
  registerModelRoutes(app, discovery ?? new HttpModelDiscovery(credentials));
  registerMatchRoutes(app, service);
  registerExperimentRoutes(app, service, store);
  // Cancel moves before waiting for in-flight NextMove HTTP handlers to close.
  app.addHook('preClose', async () => { await service.close(); });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof MatchCommandError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof StorageError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.code === 'StorageUnavailable' ? 'Хранилище недоступно. Проверьте DATA_DIR и свободное место.' : error.code === 'CorruptExperiment' ? 'Файл эксперимента повреждён или имеет неподдерживаемую версию.' : 'Эксперимент не найден.' } });
    if (error.validation || (error.statusCode !== undefined && error.statusCode < 500)) {
      return reply.code(400).send({ error: { code: 'InvalidRequest', message: 'Request does not match the API schema' } });
    }
    app.log.error(error, 'Request failed');
    return reply.code(500).send({ error: { code: 'InternalError', message: 'Internal server error' } });
  });
  return app;
}
