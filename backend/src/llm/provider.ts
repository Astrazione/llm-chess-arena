// Architectural contracts only. No network calls or chess logic in stage 1.
export type ProviderId = 'openai-compatible' | 'mock';

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
  // Name of a server-side env variable; never the secret itself.
  apiKeyEnv?: string;
}

export interface ProviderCapabilities {
  temperature: boolean;
  maxOutputTokens: boolean;
}

export interface ModelAvailability {
  available: boolean;
  capabilities: ProviderCapabilities;
  diagnostic?: string;
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface CompletionResponse {
  rawText: string;
  responseTimeMs: number;
  inputTokens?: number;
  outputTokens?: number;
  modelLoadTimeMs?: number;
  generationTimeMs?: number;
}

export interface LlmProvider {
  probe(config: ModelConfiguration, signal: AbortSignal): Promise<ModelAvailability>;
  complete(
    config: ModelConfiguration,
    request: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResponse>;
}
