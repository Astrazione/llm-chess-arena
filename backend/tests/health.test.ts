import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('backend readiness', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'arena-test-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('returns the public health contract without exposing configuration', async () => {
    const app = buildApp(loadConfig({ DATA_DIR: join(directory, 'experiments'), LOG_LEVEL: 'silent' }));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', service: 'backend' });
      expect(response.headers['cache-control']).toBe('no-store');
      await writeFile(join(directory, 'experiments', 'probe.json'), '{}');
    } finally {
      await app.close();
    }
  });

  it('refuses readiness when the storage path is a file', async () => {
    const dataDir = join(directory, 'file');
    await writeFile(dataDir, '{}');
    const app = buildApp(loadConfig({ DATA_DIR: dataDir, LOG_LEVEL: 'silent' }));
    try {
      await expect(app.ready()).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
