export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL is invalid');
  }
  const dataDir = env.DATA_DIR ?? '/data/experiments';
  if (!dataDir.trim()) throw new Error('DATA_DIR must not be empty');

  return { host: env.HOST ?? '0.0.0.0', port, dataDir, logLevel };
}
