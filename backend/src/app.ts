import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { registerHealthRoute } from './routes/health.js';

export function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestTimeout: 30_000,
  });

  // Fail before accepting traffic if the experiment volume is not writable.
  app.addHook('onReady', async () => {
    await mkdir(config.dataDir, { recursive: true });
    await access(config.dataDir, constants.R_OK | constants.W_OK);
  });
  registerHealthRoute(app);
  return app;
}
