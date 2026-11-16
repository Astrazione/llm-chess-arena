import { setTimeout as delay } from 'node:timers/promises';
import type { MockSettings } from '../contracts/match.js';
import type { CompletionRequest, CompletionResponse, LlmProvider, ModelConfiguration, ModelAvailability } from './provider.js';

export class MockLlmProvider implements LlmProvider {
  #seed: number;
  #calls = 0;
  constructor(
    readonly settings: MockSettings,
    readonly legalMovesForFen: (fen: string) => readonly string[],
  ) {
    this.#seed = settings.seed || 1;
  }

  async probe(_config: ModelConfiguration, signal: AbortSignal): Promise<ModelAvailability> {
    signal.throwIfAborted();
    return { available: true, capabilities: { temperature: false, maxOutputTokens: false } };
  }

  #randomMove(fen: string): string {
    // This list is injected by the test composition, never inferred from a model prompt.
    const moves = this.legalMovesForFen(fen);
    if (moves.length === 0) throw new Error('No legal moves supplied to Mock Provider');
    let x = this.#seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.#seed = x >>> 0;
    return moves[this.#seed % moves.length]!;
  }

  async complete(_config: ModelConfiguration, request: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> {
    signal.throwIfAborted();
    const started = performance.now();
    const call = ++this.#calls;
    const delayMs = this.settings.delayMs ?? (this.settings.strategy === 'DelayedResponse' ? 1000 : 0);
    if (delayMs) await delay(delayMs, undefined, { signal });
    signal.throwIfAborted();

    let rawText: string;
    if (this.settings.strategy === 'MalformedResponse') {
      rawText = '{"move":';
    } else {
      let move: string;
      if (this.settings.strategy === 'ScriptedMoves') {
        const scripted = this.settings.moves?.[call - 1];
        if (scripted === undefined) throw new Error('Mock script exhausted');
        move = scripted;
      } else if (this.settings.strategy === 'InvalidMove' && call % (this.settings.invalidEvery ?? 2) === 0) {
        move = 'a1a1';
      } else {
        move = this.#randomMove(request.position.fen);
      }
      rawText = JSON.stringify({ move });
    }
    return {
      rawText, responseTimeMs: performance.now() - started,
      diagnostics: { provider: 'mock', strategy: this.settings.strategy, requestNumber: call },
    };
  }
}
