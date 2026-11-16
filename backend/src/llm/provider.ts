import type { MoveErrorCode, ProviderDiagnostics, RequestMetrics } from '../contracts/match.js';
export type { CompletionRequest } from '../contracts/match.js';
import type { CompletionRequest } from '../contracts/match.js';
import { MoveResponseError } from '../application/move-response.js';
export type ProviderId = 'openai-compatible' | 'mock';
export class ProviderRequestError extends MoveResponseError {
  constructor(message: string, readonly metrics: RequestMetrics, readonly diagnostics: ProviderDiagnostics = {}, code: MoveErrorCode = 'ProviderError') {
    super(code, message);
  }
}

export interface ModelConfiguration {
  provider: ProviderId;
  baseUrl: string;
  modelId: string;
  // Runtime/model metadata is explicit for reproducible local experiments.
  runtime?: string;
  modelRevision?: string;
  quantization?: string;
  maxContextTokens?: number;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  credentialProfile?: string;
  tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
  responseFormat?: 'text' | 'json_object';
}

export interface ProviderCapabilities {
  temperature: boolean;
  maxOutputTokens: boolean;
}

export interface ModelAvailability {
  available: boolean;
  capabilities: ProviderCapabilities;
  diagnostic?: string;
  metrics?: RequestMetrics;
}

export interface CompletionResponse {
  rawText: string;
  responseTimeMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelLoadTimeMs?: number;
  generationTimeMs?: number;
  diagnostics?: ProviderDiagnostics;
}

export function requestMetrics(response?: CompletionResponse): RequestMetrics {
  return {
    responseTimeMs: response?.responseTimeMs ?? null, inputTokens: response?.inputTokens ?? null,
    outputTokens: response?.outputTokens ?? null, totalTokens: response?.totalTokens ?? null,
    generationTimeMs: response?.generationTimeMs ?? null, modelLoadTimeMs: response?.modelLoadTimeMs ?? null,
  };
}

export interface LlmProvider {
  probe(config: ModelConfiguration, signal: AbortSignal): Promise<ModelAvailability>;
  complete(
    config: ModelConfiguration,
    request: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResponse>;
}
