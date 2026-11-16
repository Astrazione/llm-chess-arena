import { describe, expect, it } from 'vitest';
import { ChessEngine } from '../src/domain/chess/engine.js';
import { MockLlmProvider } from '../src/llm/mock-provider.js';
import { buildMoveRequest } from '../src/application/prompts.js';
import { normalizeConfig } from '../src/application/match-service.js';
import { parseMoveResponse } from '../src/application/move-response.js';
import type { ModelConfiguration } from '../src/llm/provider.js';

const model: ModelConfiguration = { provider: 'mock', baseUrl: 'mock://local', modelId: 'test', timeoutMs: 1000 };
const engine = new ChessEngine();
const legal = () => engine.legalMovesUci();
const request = buildMoveRequest(engine, 'white', normalizeConfig());
const signal = () => new AbortController().signal;

describe('Mock Provider', () => {
  it('chooses deterministic legal moves from an injected list, even in mode A', async () => {
    expect(request.position.legalMoves).toBeUndefined();
    const a = new MockLlmProvider({ strategy: 'RandomLegalMove', seed: 42 }, legal);
    const b = new MockLlmProvider({ strategy: 'RandomLegalMove', seed: 42 }, legal);
    const moves: string[] = [];
    for (let index = 0; index < 10; index++) {
      const first = await a.complete(model, request, signal());
      const second = await b.complete(model, request, signal());
      expect(first.rawText).toBe(second.rawText);
      moves.push(parseMoveResponse(first.rawText));
    }
    expect(moves.every(move => legal().includes(move))).toBe(true);
    expect(new Set(moves).size).toBeGreaterThan(1);
  });

  it('follows a script without replacing errors or an exhausted script', async () => {
    const provider = new MockLlmProvider({ strategy: 'ScriptedMoves', moves: ['e2e5', 'e2e4'] }, legal);
    expect(parseMoveResponse((await provider.complete(model, request, signal())).rawText)).toBe('e2e5');
    expect(parseMoveResponse((await provider.complete(model, request, signal())).rawText)).toBe('e2e4');
    await expect(provider.complete(model, request, signal())).rejects.toThrow('exhausted');
  });

  it('returns periodic illegal moves', async () => {
    const provider = new MockLlmProvider({ strategy: 'InvalidMove', invalidEvery: 2 }, legal);
    expect(legal()).toContain(parseMoveResponse((await provider.complete(model, request, signal())).rawText));
    expect(parseMoveResponse((await provider.complete(model, request, signal())).rawText)).toBe('a1a1');
  });

  it('returns malformed JSON', async () => {
    const provider = new MockLlmProvider({ strategy: 'MalformedResponse' }, legal);
    expect(() => parseMoveResponse('{"move":')).toThrow();
    expect((await provider.complete(model, request, signal())).rawText).toBe('{"move":');
  });

  it('cancels a delayed response', async () => {
    const provider = new MockLlmProvider({ strategy: 'DelayedResponse', delayMs: 10000 }, legal);
    const controller = new AbortController();
    const pending = provider.complete(model, request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
