import type { DiscoveredModel, ModelConnection, ModelList } from '../contracts/match.js';
import { normalizeBaseUrl, ProviderCredentials } from './credentials.js';
import { withDeadline } from './deadline.js';
import { readBody } from './openai-compatible.js';

// Discovery is read-only and independent of completion/preflight capabilities.
export interface ModelDiscovery {
  list(connection: ModelConnection, signal: AbortSignal): Promise<ModelList>;
}
export class DiscoveryError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502) { super(message); }
}
const invalid = () => new DiscoveryError('InvalidModelList', 'Сервер вернул некорректный список моделей. Доступен ручной ввод Model ID.');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit = 256): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= limit && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? value : undefined;

export function discoveryBaseUrl(value: string): string {
  const base = normalizeBaseUrl(value);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}
export const defaultDiscoveryUrls = [
  'http://vllm:8000/v1', 'http://host.docker.internal:8000/v1',
  'http://host.docker.internal:11434/v1', 'http://model-runner.docker.internal/engines/v1',
];
export function discoveryUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.LLM_DISCOVERY_URLS_JSON) return defaultDiscoveryUrls;
  try {
    const values: unknown = JSON.parse(env.LLM_DISCOVERY_URLS_JSON);
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string')) throw new Error();
    return [...defaultDiscoveryUrls, ...values.map(value => discoveryBaseUrl(value as string))];
  } catch { throw new Error('Invalid LLM_DISCOVERY_URLS_JSON: expected an array of inference Base URLs'); }
}

export class HttpModelDiscovery implements ModelDiscovery {
  readonly #allowed: Set<string>;
  constructor(readonly credentials: ProviderCredentials, allowed = discoveryUrls(), readonly timeoutMs = 5000) {
    this.#allowed = new Set([...allowed, ...credentials.list().map(profile => profile.baseUrl)].map(discoveryBaseUrl));
  }
  async list(connection: ModelConnection, signal: AbortSignal): Promise<ModelList> {
    let base: string;
    let key: string | undefined;
    try {
      base = discoveryBaseUrl(connection.baseUrl);
      key = this.credentials.resolve(connection.baseUrl, connection.credentialProfile);
    } catch { throw new DiscoveryError('InvalidConnection', 'Некорректный Base URL или профиль ключа.', 400); }
    if (!this.#allowed.has(base)) throw new DiscoveryError('DiscoveryForbidden', 'Адрес не разрешён для обнаружения моделей. Добавьте Base URL в server env LLM_DISCOVERY_URLS_JSON или используйте ручной ввод.', 403);
    try {
      return await withDeadline(signal, this.timeoutMs, async active => {
        const get = async (url: string, requestSignal = active): Promise<unknown> => {
          const response = await fetch(url, { signal: requestSignal, redirect: 'error', headers: key ? { Authorization: `Bearer ${key}` } : {} });
          if (!response.ok) {
            await response.body?.cancel();
            throw new DiscoveryError('ModelListUnavailable', `Список моделей недоступен (HTTP ${response.status}). Проверьте подключение или введите Model ID вручную.`);
          }
          try { return JSON.parse(await readBody(response, requestSignal)); }
          catch { requestSignal.throwIfAborted(); throw invalid(); }
        };
        const ollama = connection.discoveryApi === 'ollama';
        const root = base.slice(0, -3);
        const envelope = object(await get(ollama ? `${root}/api/tags` : `${base}/models`));
        const entries = ollama ? envelope.models : envelope.data;
        if (!Array.isArray(entries) || entries.length > 2000) throw invalid();
        const models: DiscoveredModel[] = entries.map(entry => {
          const model = object(entry);
          const id = text(ollama ? model.model ?? model.name : model.id);
          if (!id) throw invalid();
          // Redact even metadata: a misbehaving server might reflect a credential.
          const safeId = this.credentials.redact(id);
          if (safeId !== id) throw invalid();
          const result: DiscoveredModel = { id, displayName: id, provider: connection.discoveryApi, status: 'available' };
          if (ollama) {
            const details = model.details === undefined ? {} : object(model.details);
            const parameters = text(details.parameter_size);
            const quantization = text(details.quantization_level);
            if (parameters) result.parameterSize = this.credentials.redact(parameters);
            if (quantization) result.quantization = this.credentials.redact(quantization);
            if (typeof model.size === 'number' && Number.isSafeInteger(model.size) && model.size >= 0) result.sizeBytes = model.size;
          }
          return result;
        });
        const warnings: string[] = [];
        if (ollama && models.length) {
          try {
            const running = object(await withDeadline(active, 1000, check => get(`${root}/api/ps`, check))).models;
            if (!Array.isArray(running) || running.length > 2000) throw invalid();
            const loaded = new Set(running.map(entry => {
              const model = object(entry);
              const id = text(model.model ?? model.name);
              if (!id) throw invalid();
              return id;
            }));
            for (const model of models) model.status = loaded.has(model.id) ? 'loaded' : 'cached';
          } catch {
            active.throwIfAborted();
            warnings.push('Список скачанных моделей получен, но состояние загрузки в память неизвестно: /api/ps недоступен.');
          }
        }
        return { schemaVersion: 1, models: [...new Map(models.map(model => [model.id, model])).values()], warnings };
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DiscoveryError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'Timeout') throw new DiscoveryError('DiscoveryTimeout', 'Истёк тайм-аут получения моделей. Выбранный ID сохранён.', 504);
      throw new DiscoveryError('DiscoveryUnreachable', 'Не удалось подключиться к inference-серверу (сеть, TLS или redirect). Доступен ручной ввод Model ID.');
    }
  }
}
