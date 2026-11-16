import type { CompletionRequest, ProviderDiagnostics } from '../contracts/match.js';
import { ProviderCredentials, normalizeBaseUrl } from './credentials.js';
import { withDeadline } from './deadline.js';
import { connectionCheckRequest, ProviderRequestError, requestMetrics, type CompletionResponse, type LlmProvider, type ModelAvailability, type ModelConfiguration } from './provider.js';
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tokens = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBody(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Response size limit'); }
      chunks.push(value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(readonly credentials = new ProviderCredentials()) {}

  async probe(config: ModelConfiguration, signal: AbortSignal): Promise<ModelAvailability> {
    // No universal capabilities/discovery API exists. Validate the exact selected
    // fields with a real completion; never silently remove rejected parameters.
    const response = await this.complete(config, connectionCheckRequest(), signal);
    if (!response.rawText.trim()) throw new ProviderRequestError('Model connection check returned no text', requestMetrics(response), {}, 'EmptyResponse');
    return {
      available: true, capabilities: { temperature: config.temperature !== undefined, maxOutputTokens: config.maxOutputTokens !== undefined },
      rawText: response.rawText,
      diagnostic: 'Endpoint accepted the model and selected parameters. A compatible API may silently ignore unsupported fields; consult its model documentation.',
      metrics: requestMetrics(response),
      diagnostics: { ...response.diagnostics, endpointState: 'responding', ...(await this.#modelMetadata(config, signal)) },
    };
  }

  async #modelMetadata(config: ModelConfiguration, signal: AbortSignal): Promise<ProviderDiagnostics> {
    // Optional standard discovery. Failure must not reject a working completion.
    // No VRAM estimate or configured context is presented as measured telemetry.
    try {
      return await withDeadline(signal, Math.min(config.timeoutMs, 2000), async active => {
        const key = this.credentials.resolve(config.baseUrl, config.credentialProfile);
        const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/models`, {
          signal: active, redirect: 'error', headers: key ? { Authorization: `Bearer ${key}` } : {},
        });
        if (!response.ok) { await response.body?.cancel(); return { modelMetadata: 'unavailable' }; }
        const envelope = record(JSON.parse(await readBody(response, active)));
        const model = Array.isArray(envelope.data) ? envelope.data.map(record).find(item => item.id === config.modelId) : undefined;
        if (!model) return { modelMetadata: 'unavailable' };
        const context = tokens(model.max_model_len ?? model.context_length);
        return { modelMetadata: 'reported', listedModel: this.credentials.redact(config.modelId),
          ...(context && context > 0 ? { reportedMaxContextTokens: context } : {}) };
      });
    } catch { signal.throwIfAborted(); return { modelMetadata: 'unavailable' }; }
  }

  complete(config: ModelConfiguration, request: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> {
    return withDeadline(signal, config.timeoutMs, active => this.#send(config, request, active));
  }

  async #send(config: ModelConfiguration, request: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse> {
    const started = performance.now();
    const metrics = () => ({ ...requestMetrics(), responseTimeMs: performance.now() - started });
    const fail = (message: string, diagnostics?: ProviderDiagnostics) => new ProviderRequestError(message, metrics(), diagnostics);
    let url: string;
    let key: string | undefined;
    try {
      url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
      key = this.credentials.resolve(config.baseUrl, config.credentialProfile);
    } catch { throw fail('Invalid Base URL or server credential profile'); }
    const body: Record<string, unknown> = {
      model: config.modelId, stream: false,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.seed !== undefined) body.seed = config.seed;
    if (config.maxOutputTokens !== undefined) body[config.tokenLimitParameter ?? 'max_tokens'] = config.maxOutputTokens;
    if (config.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      signal.throwIfAborted();
      throw fail('Cannot connect to provider (network, TLS or redirect error). Check Base URL, runtime health and Docker-to-host access; localhost inside backend refers to the container.', { endpointState: 'unreachable' });
    }
    if (!response.ok) {
      let outOfMemory = false;
      try {
        const error = record(record(JSON.parse(await readBody(response, signal, 16384))).error);
        // Classify only; never forward upstream text, paths, config or secrets.
        outOfMemory = [error.message, error.type, error.code].some(value => typeof value === 'string' && /out[ _-]?of[ _-]?memory|cuda.*alloc|insufficient.*memory/i.test(value));
      } catch { signal.throwIfAborted(); }
      const message = response.status === 429 ? 'Provider rate limit exceeded (HTTP 429)'
        : response.status === 401 || response.status === 403 ? 'Provider authentication failed'
        : response.status === 400 || response.status === 422 ? 'Provider rejected the model or generation parameters; check temperature, token limit field and JSON mode'
        : `Provider HTTP error ${response.status}`;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw fail(outOfMemory ? 'Inference runtime reported out of memory. Reduce context/concurrency or use smaller quantized weights; inspect runtime logs.' : message,
        { httpStatus: response.status, endpointState: 'responding', ...(outOfMemory ? { resourceError: 'OutOfMemory' } : {}), ...(response.headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}) });
    }
    let rawBody: string;
    try {
      rawBody = await readBody(response, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === 'Response size limit') throw fail('Provider response exceeded 1 MiB');
      throw fail('Provider response could not be read');
    }
    let envelope: Record<string, unknown>;
    try { envelope = record(JSON.parse(rawBody)); }
    catch { throw fail('Provider returned invalid Chat Completions JSON'); }
    if (envelope.error) throw fail('Provider returned an API error');
    const choices = envelope.choices;
    if (!Array.isArray(choices) || !choices.length) throw fail('Provider returned no completion choices');
    const choice = record(choices[0]);
    const content = record(choice.message).content;
    if (content !== null && typeof content !== 'string') throw fail('Provider returned unsupported message content');
    const usage = record(envelope.usage);
    // Ignore reasoning and arbitrary metadata: only public message.content enters the experiment.
    return {
      rawText: this.credentials.redact(content ?? ''), responseTimeMs: performance.now() - started,
      ...(tokens(usage.prompt_tokens) !== undefined ? { inputTokens: tokens(usage.prompt_tokens)! } : {}),
      ...(tokens(usage.completion_tokens) !== undefined ? { outputTokens: tokens(usage.completion_tokens)! } : {}),
      ...(tokens(usage.total_tokens) !== undefined ? { totalTokens: tokens(usage.total_tokens)! } : {}),
      diagnostics: { provider: 'openai-compatible', httpStatus: response.status,
        ...(typeof envelope.model === 'string' ? { reportedModel: this.credentials.redact(envelope.model).slice(0, 256) } : {}),
        ...(typeof choice.finish_reason === 'string' ? { finishReason: this.credentials.redact(choice.finish_reason).slice(0, 128) } : {}) },
    };
  }
}
