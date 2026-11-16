import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MatchService } from '../src/application/match-service.js';
import { ProviderCredentials } from '../src/llm/credentials.js';
import { discoveryUrls, HttpModelDiscovery } from '../src/llm/model-discovery.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
async function api(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const paths: string[] = [];
  const server = createServer((request, response) => { paths.push(request.url!); handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const root = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { root, baseUrl: `${root}/v1`, paths };
}
const credentials = () => new ProviderCredentials({});

describe('HTTP model discovery', () => {
  it('lists downloaded Ollama models with exact IDs, optional metadata and separately reported loaded state', async () => {
    const endpoint = await api((request, response) => response.end(JSON.stringify(request.url === '/api/tags' ? { models: [
      { name: 'alias', model: 'qwen:7b', size: 1234, details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } }, { name: 'other:latest' },
    ] } : { models: [{ model: 'qwen:7b' }] })));
    const discovery = new HttpModelDiscovery(credentials(), [endpoint.baseUrl]);
    for (const baseUrl of [endpoint.root, `${endpoint.baseUrl}/`]) {
      expect(await discovery.list({ baseUrl, discoveryApi: 'ollama' }, signal())).toEqual({ schemaVersion: 1, warnings: [], models: [
        { id: 'qwen:7b', displayName: 'qwen:7b', provider: 'ollama', status: 'loaded', sizeBytes: 1234, parameterSize: '7B', quantization: 'Q4_K_M' },
        { id: 'other:latest', displayName: 'other:latest', provider: 'ollama', status: 'cached' },
      ] });
    }
    expect(endpoint.paths).toEqual(['/api/tags', '/api/ps', '/api/tags', '/api/ps']);
  });
  it('does not infer loaded/cached state when optional Ollama ps is unsupported', async () => {
    const endpoint = await api((request, response) => {
      if (request.url === '/api/ps') response.writeHead(404);
      response.end('{"models":[{"name":"qwen:7b"}]}');
    });
    const result = await new HttpModelDiscovery(credentials(), [endpoint.baseUrl]).list({ baseUrl: endpoint.baseUrl, discoveryApi: 'ollama' }, signal());
    expect(result.models[0]).toMatchObject({ status: 'available' }); expect(result.warnings).toHaveLength(1);
  });
  it.each(['vllm', 'openai-compatible'] as const)('lists %s served models using a single /v1 and no fabricated metadata', async discoveryApi => {
    const endpoint = await api((_request, response) => response.end('{"data":[{"id":"org/served"},{"id":"org/served"}]}'));
    const discovery = new HttpModelDiscovery(credentials(), [endpoint.baseUrl]);
    for (const baseUrl of [endpoint.root, endpoint.baseUrl, `${endpoint.baseUrl}/`]) {
      expect((await discovery.list({ baseUrl, discoveryApi }, signal())).models).toEqual([{ id: 'org/served', displayName: 'org/served', provider: discoveryApi, status: 'available' }]);
    }
    expect(endpoint.paths).toEqual(['/v1/models', '/v1/models', '/v1/models']);
  });
  it('preserves a reverse proxy API prefix', async () => {
    const endpoint = await api((_req, res) => res.end('{"data":[]}'));
    const baseUrl = `${endpoint.root}/engines/v1`;
    await new HttpModelDiscovery(credentials(), [baseUrl]).list({ baseUrl, discoveryApi: 'vllm' }, signal());
    expect(endpoint.paths).toEqual(['/engines/v1/models']);
  });
  it.each(['vllm', 'ollama'] as const)('accepts an empty %s list without loading anything', async discoveryApi => {
    const endpoint = await api((_request, response) => response.end(discoveryApi === 'ollama' ? '{"models":[]}' : '{"data":[]}'));
    expect(await new HttpModelDiscovery(credentials(), [endpoint.baseUrl]).list({ baseUrl: endpoint.baseUrl, discoveryApi }, signal())).toEqual({ schemaVersion: 1, models: [], warnings: [] });
    expect(endpoint.paths).toHaveLength(1);
  });
  it.each(['not json', '{}', '{"data":[{}]}', '{"data":{}}', '{"data":[{"id":""}]}', JSON.stringify({ data: Array.from({ length: 2001 }, () => ({ id: 'x' })) })])('rejects malformed or excessive lists', async body => {
    const endpoint = await api((_req, res) => res.end(body));
    await expect(new HttpModelDiscovery(credentials(), [endpoint.baseUrl]).list({ baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ code: 'InvalidModelList' });
  });
  it('limits streamed response size and times out while reading the body', async () => {
    const large = await api((_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
    await expect(new HttpModelDiscovery(credentials(), [large.baseUrl]).list({ baseUrl: large.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ code: 'InvalidModelList' });
    const slow = await api((_req, res) => { res.writeHead(200); res.write('{"data":['); });
    await expect(new HttpModelDiscovery(credentials(), [slow.baseUrl], 50).list({ baseUrl: slow.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ code: 'DiscoveryTimeout' });
  });
  it('handles unreachable endpoints and aborts without exposing network details', async () => {
    const endpoint = await api(() => {});
    const discovery = new HttpModelDiscovery(credentials(), [endpoint.baseUrl]);
    const controller = new AbortController();
    const pending = discovery.list({ baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' }, controller.signal);
    controller.abort(new Error('cancel test'));
    await expect(pending).rejects.toThrow('cancel test');
    await cleanups.pop()!();
    await expect(discovery.list({ baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ code: 'DiscoveryUnreachable' });
  });
  it('restricts destinations, blocks redirects and binds credentials to the original exact Base URL', async () => {
    const secret = 'discovery-secret';
    const endpoint = await api((req, res) => { expect(req.headers.authorization).toBe(`Bearer ${secret}`); res.end(JSON.stringify({ data: [{ id: secret }] })); });
    const keys = new ProviderCredentials({ LLM_API_KEY_1: secret, LLM_ENDPOINTS_JSON: JSON.stringify({ test: { baseUrl: endpoint.baseUrl, apiKeyEnv: 'LLM_API_KEY_1' } }) });
    const discovery = new HttpModelDiscovery(keys, []);
    await expect(discovery.list({ baseUrl: endpoint.baseUrl, discoveryApi: 'vllm', credentialProfile: 'test' }, signal())).rejects.toMatchObject({ code: 'InvalidModelList' });
    await expect(discovery.list({ baseUrl: `${endpoint.root}/other`, discoveryApi: 'vllm', credentialProfile: 'test' }, signal())).rejects.toMatchObject({ code: 'InvalidConnection' });
    await expect(discovery.list({ baseUrl: 'http://169.254.169.254/latest', discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ statusCode: 403 });
    await expect(discovery.list({ baseUrl: 'https://user:secret@example.com/v1', discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ statusCode: 400 });
    const redirect = await api((_req, res) => { res.writeHead(302, { location: `${endpoint.baseUrl}/models` }); res.end(); });
    await expect(new HttpModelDiscovery(credentials(), [redirect.baseUrl]).list({ baseUrl: redirect.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toMatchObject({ code: 'DiscoveryUnreachable' });
    expect(endpoint.paths).toHaveLength(1);
  });
  it('does not disclose upstream error bodies', async () => {
    const endpoint = await api((_req, res) => { res.writeHead(401); res.end('SECRET'); });
    await expect(new HttpModelDiscovery(credentials(), [endpoint.baseUrl]).list({ baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' }, signal())).rejects.toThrow('HTTP 401');
  });
  it('validates server allowlist configuration', () => {
    expect(discoveryUrls({ LLM_DISCOVERY_URLS_JSON: '["https://inference.example"]' })).toContain('https://inference.example/v1');
    expect(() => discoveryUrls({ LLM_DISCOVERY_URLS_JSON: '["file:///etc"]' })).toThrow('LLM_DISCOVERY_URLS_JSON');
  });
});

describe('model discovery REST lifecycle', () => {
  it('retains the discovered ID and repeats preflight even if the model has disappeared', async () => {
    const endpoint = await api((req, res) => {
      if (req.method === 'GET') res.end('{"data":[{"id":"retired:model"}]}');
      else { res.writeHead(404); res.end('PRIVATE upstream error'); }
    });
    const keys = credentials();
    const models = await new HttpModelDiscovery(keys, [endpoint.baseUrl]).list({ baseUrl: endpoint.root, discoveryApi: 'vllm' }, signal());
    const service = new MatchService(keys);
    cleanups.push(async () => { await service.close(); });
    const match = service.create({ players: {
      white: { provider: 'openai-compatible', providerName: 'vLLM', baseUrl: endpoint.root, discoveryApi: 'vllm', modelId: models.models[0]!.id, timeoutMs: 1000, responseFormat: 'text', tokenLimitParameter: 'max_tokens' },
      black: { strategy: 'RandomLegalMove' },
    } });
    await match.nextMove();
    const snapshot = match.snapshot();
    expect(snapshot.config.players.white).toMatchObject({ modelId: 'retired:model', discoveryApi: 'vllm' });
    expect(snapshot.attempts).toHaveLength(0);
    expect(snapshot.position.history).toHaveLength(0);
    expect(snapshot.providerChecks[0]?.result.available).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(endpoint.paths).toEqual(['/v1/models', '/v1/chat/completions']);
  });
  it('validates DTOs, disallows cross-site requests and keeps health available', async () => {
    const endpoint = await api((_req, res) => res.end('{"data":[{"id":"served"}]}'));
    const keys = credentials();
    const app = buildApp(loadConfig({ DATA_DIR: '/tmp/arena-discovery-test', LOG_LEVEL: 'silent' }), new MatchService(keys), new HttpModelDiscovery(keys, [endpoint.baseUrl]));
    cleanups.push(async () => { await app.close(); });
    const payload = { baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' };
    const success = await app.inject({ method: 'POST', url: '/api/providers/models', payload });
    expect(success.statusCode).toBe(200); expect(success.headers['cache-control']).toBe('no-store');
    expect(success.json().models[0].id).toBe('served');
    expect((await app.inject({ method: 'POST', url: '/api/providers/models', payload: { ...payload, apiKey: 'secret' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/providers/models', payload, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
  it('bounds concurrency and cancels active discovery in preClose', async () => {
    let count = 0;
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const endpoint = await api(() => { if (++count === 4) arrived(); });
    const keys = credentials();
    const app = buildApp(loadConfig({ DATA_DIR: '/tmp/arena-discovery-test', LOG_LEVEL: 'silent' }), new MatchService(keys), new HttpModelDiscovery(keys, [endpoint.baseUrl]));
    const call = () => app.inject({ method: 'POST', url: '/api/providers/models', payload: { baseUrl: endpoint.baseUrl, discoveryApi: 'vllm' } }).then(value => value);
    const pending = Array.from({ length: 4 }, call);
    await arrival;
    expect((await call()).statusCode).toBe(429);
    await app.close();
    expect((await Promise.all(pending)).every(response => response.statusCode === 503)).toBe(true);
  });
});
