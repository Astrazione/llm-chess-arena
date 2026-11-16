import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { ProviderCredentials } from '../src/llm/credentials.js';
import type { ModelConfiguration } from '../src/llm/provider.js';
import type { CompatibleSettings, MatchSnapshot } from '../src/contracts/match.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MatchService, normalizeConfig } from '../src/application/match-service.js';
import { buildMoveRequest, DEFAULT_SYSTEM_PROMPT } from '../src/application/prompts.js';
import { ChessEngine } from '../src/domain/chess/engine.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
type Body = { model: string; messages: { role: string; content: string }[]; [key: string]: unknown };
async function api(handler: (body: Body, response: ServerResponse, request: IncomingMessage) => void) {
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body);
    handler(body, response, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
function send(response: ServerResponse, content: string | null = '{"move":"e2e4"}', usage?: object) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: 'PRIVATE' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }));
}
const settings = (baseUrl: string): CompatibleSettings => ({
  provider: 'openai-compatible', providerName: 'Test', baseUrl, modelId: 'model-a', timeoutMs: 2000,
  tokenLimitParameter: 'max_tokens', responseFormat: 'text',
});
const configuration = (baseUrl: string): ModelConfiguration => ({ ...settings(baseUrl) });
const request = () => buildMoveRequest(new ChessEngine(), 'white', normalizeConfig());
const signal = () => new AbortController().signal;
const adapter = () => new OpenAiCompatibleProvider(new ProviderCredentials({}));

describe('OpenAI-compatible HTTP adapter', () => {
  it('sends only public messages and selected fields, parses usage without inventing generation metrics', async () => {
    const endpoint = await api((_body, response, req) => {
      expect(req.url).toBe('/v1/chat/completions');
      send(response, '{"move":"e2e4"}', { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 });
    });
    const config = { ...configuration(endpoint.baseUrl), temperature: 0, maxOutputTokens: 64, tokenLimitParameter: 'max_completion_tokens' as const, responseFormat: 'json_object' as const };
    const completion = await adapter().complete(config, request(), signal());
    expect(completion).toMatchObject({ rawText: '{"move":"e2e4"}', inputTokens: 21, outputTokens: 9, totalTokens: 30 });
    expect(completion.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(completion.generationTimeMs).toBeUndefined();
    expect(JSON.stringify(completion)).not.toContain('PRIVATE');
    expect(endpoint.requests[0]).toMatchObject({ model: 'model-a', temperature: 0, max_completion_tokens: 64, response_format: { type: 'json_object' } });
    expect(endpoint.requests[0]).not.toHaveProperty('max_tokens');
    expect(endpoint.requests[0]?.messages).toEqual([{ role: 'system', content: request().systemPrompt }, { role: 'user', content: request().userPrompt }]);
  });

  it('omits optional fields and keeps absent token usage unknown', async () => {
    const endpoint = await api((_body, response) => send(response));
    const completion = await adapter().complete(configuration(endpoint.baseUrl), request(), signal());
    expect(endpoint.requests[0]).not.toHaveProperty('temperature');
    expect(endpoint.requests[0]).not.toHaveProperty('max_tokens');
    expect(endpoint.requests[0]).not.toHaveProperty('response_format');
    expect(completion.inputTokens).toBeUndefined();
    expect(completion.totalTokens).toBeUndefined();
  });

  it.each([400, 401, 429, 500])('handles HTTP %i without disclosing upstream bodies', async status => {
    const endpoint = await api((_body, response) => { response.writeHead(status, { 'Retry-After': '4' }); response.end('secret body'); });
    await expect(adapter().complete(configuration(endpoint.baseUrl), request(), signal())).rejects.toMatchObject({
      code: 'ProviderError', diagnostics: { httpStatus: status },
    });
    await expect(adapter().probe(configuration(endpoint.baseUrl), signal())).rejects.not.toThrow('secret body');
    expect(endpoint.requests).toHaveLength(2); // no hidden transport retries
  });

  it('bounds responses even without Content-Length and rejects invalid envelopes', async () => {
    const large = await api((_body, response) => { response.writeHead(200); response.end('x'.repeat(1024 * 1024 + 1)); });
    await expect(adapter().complete(configuration(large.baseUrl), request(), signal())).rejects.toThrow('exceeded');
    const invalid = await api((_body, response) => response.end('{invalid'));
    await expect(adapter().complete(configuration(invalid.baseUrl), request(), signal())).rejects.toThrow('invalid Chat Completions JSON');
    const noChoice = await api((_body, response) => response.end('{}'));
    await expect(adapter().complete(configuration(noChoice.baseUrl), request(), signal())).rejects.toThrow('no completion choices');
  });

  it('times out an unfinished response body and cancels the HTTP connection', async () => {
    let disconnected: Promise<unknown> | undefined;
    const endpoint = await api((_body, response) => { response.writeHead(200); response.write('{'); disconnected = once(response, 'close'); });
    await expect(adapter().complete({ ...configuration(endpoint.baseUrl), timeoutMs: 40 }, request(), signal())).rejects.toMatchObject({ code: 'Timeout' });
    await disconnected;
  });

  it('aborts a pending request and reports an unavailable server', async () => {
    let received!: () => void;
    const arrival = new Promise<void>(resolve => { received = resolve; });
    const endpoint = await api(() => received());
    const controller = new AbortController();
    const pending = adapter().complete(configuration(endpoint.baseUrl), request(), controller.signal);
    await arrival;
    controller.abort(new Error('cancelled by test'));
    await expect(pending).rejects.toThrow('cancelled by test');
    const unavailable = await api(() => {});
    await cleanups.pop()!();
    await expect(adapter().complete(configuration(unavailable.baseUrl), request(), signal())).rejects.toMatchObject({ code: 'ProviderError' });
  });

  it('binds server credentials to the exact URL, blocks redirects and redacts echoed secrets', async () => {
    const secret = 'test-secret-123';
    const endpoint = await api((_body, response, req) => { expect(req.headers.authorization).toBe(`Bearer ${secret}`); send(response, secret); });
    const credentials = new ProviderCredentials({ LLM_API_KEY_1: secret, LLM_ENDPOINTS_JSON: JSON.stringify({ custom: { baseUrl: endpoint.baseUrl, apiKeyEnv: 'LLM_API_KEY_1' } }) });
    expect(credentials.list()).toEqual([{ id: 'custom', baseUrl: endpoint.baseUrl }]);
    const provider = new OpenAiCompatibleProvider(credentials);
    const config = { ...configuration(endpoint.baseUrl), credentialProfile: 'custom' };
    expect((await provider.complete(config, request(), signal())).rawText).toBe('[REDACTED]');
    await expect(provider.complete({ ...config, baseUrl: `${endpoint.baseUrl}/other` }, request(), signal())).rejects.toThrow('credential profile');
    const redirect = await api((_body, response) => { response.writeHead(307, { Location: `${endpoint.baseUrl}/chat/completions` }); response.end(); });
    await expect(provider.complete(configuration(redirect.baseUrl), request(), signal())).rejects.toThrow('redirect');
    expect(endpoint.requests).toHaveLength(1);
    expect(() => normalizeConfig({ players: { white: settings('https://user:secret@example.com/v1'), black: { strategy: 'RandomLegalMove' } } })).toThrow();
  });
});

describe('real HTTP endpoints through match REST and prompts', () => {
  async function appForTest() {
    const app = buildApp(loadConfig({ DATA_DIR: '/tmp/arena-compatible-test', LOG_LEVEL: 'silent' }), new MatchService(new ProviderCredentials({})));
    cleanups.push(async () => { await app.close(); });
    return app;
  }
  it('uses independent endpoints, retries malformed and illegal moves without changing or leaking the position', async () => {
    const white = await api((body, response) => {
      if (body.messages[1]!.content.startsWith('Connection check')) return send(response);
      const count = white.requests.filter(item => !item.messages[1]!.content.startsWith('Connection check')).length;
      send(response, count === 1 ? '{"move":' : count === 2 ? '{"move":"e2e5"}' : '{"move":"e2e4"}', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    });
    const black = await api((body, response) => send(response, body.messages[1]!.content.startsWith('Connection check') ? '{"move":"e2e4"}' : '{"move":"e7e5"}'));
    const app = await appForTest();
    const created = (await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'A', players: {
      white: { ...settings(white.baseUrl), systemPrompt: 'White-only {{color}} {{fen}} {{history}}' },
      black: { ...settings(black.baseUrl), systemPrompt: 'Black-only {{color}}' },
    } } })).json<MatchSnapshot>();
    expect(created.status).toBe('Created');
    const next = async () => (await app.inject({ method: 'POST', url: `/api/matches/${created.id}/next-move` })).json<MatchSnapshot>();
    const first = await next();
    expect(first.position.history.map(move => move.uci)).toEqual(['e2e4']);
    expect(first.attempts.map(attempt => attempt.error?.code ?? 'Accepted')).toEqual(['InvalidFormat', 'IllegalMove', 'Accepted']);
    expect(new Set(first.attempts.map(attempt => attempt.request.position.fen)).size).toBe(1);
    expect(first.attempts[2]?.attemptNumber).toBe(3);
    expect(first.attempts.every(attempt => attempt.metrics?.totalTokens === 15)).toBe(true);
    expect(first.providerChecks).toHaveLength(2);
    const second = await next();
    expect(second.position.history.map(move => move.uci)).toEqual(['e2e4', 'e7e5']);
    expect(second.attempts.at(-1)?.metrics).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, generationTimeMs: null });
    for (const body of [...white.requests, ...black.requests]) {
      expect(JSON.stringify(body)).not.toContain('legalMoves');
      expect(body.messages).toHaveLength(2);
    }
    const blackMove = black.requests.at(-1)!;
    expect(blackMove.messages[0]?.content).toBe('Black-only black');
    expect(JSON.stringify(blackMove)).not.toContain('White-only');
    expect(JSON.stringify(blackMove)).not.toContain('IllegalMove');
    expect(JSON.parse(blackMove.messages[1]!.content).history).toEqual(['e2e4']);
    const whiteMoves = white.requests.slice(1);
    expect(JSON.parse(whiteMoves[1]!.messages[1]!.content).previousError.code).toBe('InvalidFormat');
    expect(JSON.parse(whiteMoves[2]!.messages[1]!.content).previousError.code).toBe('IllegalMove');
    expect(first.attempts[0]?.request.systemPrompt).not.toContain('{{');
  });

  it('exposes safe provider info/check failures and rejects keys or unknown template variables', async () => {
    const endpoint = await api((_body, response) => { response.writeHead(400); response.end('sensitive detail'); });
    const app = await appForTest();
    const info = (await app.inject('/api/providers')).json();
    expect(info).toEqual({ profiles: [], defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT });
    const probe = await app.inject({ method: 'POST', url: '/api/providers/probe', payload: settings(endpoint.baseUrl) });
    expect(probe.json()).toMatchObject({ available: false, error: { code: 'ProviderError' } });
    expect(probe.body).not.toContain('sensitive detail');
    expect((await app.inject({ method: 'POST', url: '/api/providers/probe', payload: { ...settings(endpoint.baseUrl), apiKey: 'secret' } })).statusCode).toBe(400);
    expect(() => normalizeConfig({ systemPrompt: '{{legalMoves}}' })).toThrow('Unknown prompt variable');
    const game = (await app.inject({ method: 'POST', url: '/api/matches', payload: { players: { white: settings(endpoint.baseUrl), black: { strategy: 'RandomLegalMove' } } } })).json<MatchSnapshot>();
    const result = (await app.inject({ method: 'POST', url: `/api/matches/${game.id}/next-move` })).json<MatchSnapshot>();
    expect(result.attempts).toEqual([]);
    expect(result.result).toMatchObject({ kind: 'TechnicalLoss', reason: 'ProviderError' });
  });

  it('substitutes templates for every position and keeps exact legal moves only in mode B', () => {
    const engine = new ChessEngine();
    const config = normalizeConfig({ mode: 'B', systemPrompt: '{{color}}\n{{fen}}\n{{ascii}}\n{{history}}' });
    const white = buildMoveRequest(engine, 'white', config);
    expect(white.systemPrompt).toContain(engine.fen);
    expect(white.position.legalMoves).toEqual(engine.legalMovesUci());
    engine.applyMove('e2e4');
    const black = buildMoveRequest(engine, 'black', config);
    expect(black.systemPrompt).toContain('black');
    expect(black.systemPrompt).toContain(engine.fen);
    expect(black.systemPrompt).toContain('e2e4');
    expect(black.position.legalMoves).toEqual(engine.legalMovesUci());
    expect(() => normalizeConfig({ systemPrompt: 'Missing {{color' })).toThrow('Malformed prompt');
  });

  it('retains token usage for an empty content response rejected by the parser', async () => {
    const endpoint = await api((body, response) => send(response, body.messages[1]!.content.startsWith('Connection check') ? '{"move":"e2e4"}' : null,
      { prompt_tokens: 12, completion_tokens: 4 }));
    const app = await appForTest();
    const created = (await app.inject({ method: 'POST', url: '/api/matches', payload: {
      maxRetries: 0, players: { white: settings(endpoint.baseUrl), black: { strategy: 'RandomLegalMove' } },
    } })).json<MatchSnapshot>();
    const result = (await app.inject({ method: 'POST', url: `/api/matches/${created.id}/next-move` })).json<MatchSnapshot>();
    expect(result.position.history).toEqual([]);
    expect(result.attempts[0]).toMatchObject({ rawText: '', error: { code: 'EmptyResponse' }, metrics: { inputTokens: 12, outputTokens: 4, totalTokens: null } });
    expect(result.result).toMatchObject({ kind: 'TechnicalLoss', reason: 'EmptyResponse' });
  });

  it('never exposes server key values or env names through snapshots, events or profile discovery', async () => {
    const secret = 'server-test-secret';
    const endpoint = await api((_body, response, req) => {
      expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      send(response, secret);
    });
    const credentials = new ProviderCredentials({ LLM_API_KEY_1: secret, LLM_ENDPOINTS_JSON: JSON.stringify({ test: { baseUrl: endpoint.baseUrl, apiKeyEnv: 'LLM_API_KEY_1' } }) });
    const app = buildApp(loadConfig({ DATA_DIR: '/tmp/arena-compatible-test', LOG_LEVEL: 'silent' }), new MatchService(credentials));
    cleanups.push(async () => { await app.close(); });
    const created = (await app.inject({ method: 'POST', url: '/api/matches', payload: {
      maxRetries: 0, players: { white: { ...settings(endpoint.baseUrl), credentialProfile: 'test' }, black: { strategy: 'RandomLegalMove' } },
    } })).json<MatchSnapshot>();
    const result = await app.inject({ method: 'POST', url: `/api/matches/${created.id}/next-move` });
    expect(result.json<MatchSnapshot>().attempts[0]?.rawText).toBe('[REDACTED]');
    for (const output of [result.body, (await app.inject('/api/providers')).body, (await app.inject(`/api/matches/${created.id}/events`)).body]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain('LLM_API_KEY_1');
    }
  });

  it('shutdown cancels preflight before waiting for its HTTP handler', async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const endpoint = await api(() => arrived());
    const app = await appForTest();
    const pending = app.inject({ method: 'POST', url: '/api/providers/probe', payload: { ...settings(endpoint.baseUrl), timeoutMs: 300000 } }).then(value => value);
    await arrival;
    await app.close();
    expect((await pending).json()).toMatchObject({ available: false, error: { code: 'ProviderError' } });
  });
});
