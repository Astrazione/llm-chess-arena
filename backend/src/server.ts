import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Shutting down');
  const deadline = setTimeout(() => {
    app.log.error('Shutdown deadline exceeded');
    process.exit(1);
  }, 10_000);
  deadline.unref();

  try {
    // Future orchestrator/provider cleanup belongs in Fastify onClose hooks.
    await app.close();
    app.log.info('Shutdown complete');
  } catch (error) {
    app.log.error(error, 'Shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'Startup failed');
  await app.close();
  process.exitCode = 1;
}
