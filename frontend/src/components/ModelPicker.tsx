import { useEffect, useState } from 'react';
import type { CompatibleSettings, DiscoveryApi, ModelList } from '../api/contracts';
import { discoverModels } from '../api/matches';

export function ModelPicker({ settings, side, disabled, onChange }: {
  settings: CompatibleSettings; side: string; disabled: boolean;
  onChange: (patch: Partial<CompatibleSettings>) => void;
}) {
  const [manual, setManual] = useState(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; result?: ModelList; error?: string }>({ key: '' });
  const api = settings.discoveryApi ?? 'openai-compatible';
  const key = JSON.stringify([settings.baseUrl, settings.credentialProfile ?? '', api, revision]);
  const baseUrl = settings.baseUrl;
  const profile = settings.credentialProfile;
  useEffect(() => {
    if (disabled || !baseUrl.trim()) return;
    const controller = new AbortController();
    // Debounce URL editing; model/temperature/prompt changes do not trigger discovery.
    const timer = setTimeout(() => {
      void discoverModels({ baseUrl, discoveryApi: api, ...(profile ? { credentialProfile: profile } : {}) }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setState({ key, result }); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : 'Ошибка получения моделей' }); })
        .finally(() => clearTimeout(timeout));
    }, 300);
    const timeout = setTimeout(() => {
      controller.abort();
      setState({ key, error: 'Истёк тайм-аут получения моделей. Доступен ручной ввод.' });
    }, 10000);
    return () => { clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [baseUrl, profile, api, key, disabled]);
  const current = state.key === key ? state : undefined;
  const models = current?.result?.models ?? [];
  const loading = !disabled && !!baseUrl.trim() && !current;
  const selected = models.find(model => model.id === settings.modelId);
  const status = { available: 'Доступна через API', loaded: 'В памяти', cached: 'Скачана · не загружена' };
  return <div className="model-picker">
    <label>API списка моделей · {side}<select aria-label={`API списка моделей · ${side}`} value={api} onChange={e => onChange({ discoveryApi: e.target.value as DiscoveryApi })}>
      <option value="openai-compatible">OpenAI-compatible · /v1/models</option>
      <option value="vllm">vLLM · /v1/models</option>
      <option value="ollama">Ollama · /api/tags</option>
    </select></label>
    <label><input type="checkbox" checked={manual} onChange={e => setManual(e.target.checked)} />Ручной ввод Model ID · {side}</label>
    {manual
      ? <label>Модель · {side}<input required maxLength={256} placeholder="model-id" value={settings.modelId} onChange={e => onChange({ modelId: e.target.value })} /></label>
      : <label>Модель · {side}<select required aria-label={`Модель · ${side}`} value={settings.modelId} onChange={e => onChange({ modelId: e.target.value })}>
        <option value="" disabled>Выберите модель…</option>
        {settings.modelId && !selected && <option value={settings.modelId}>{settings.modelId} · сохранённый ID, наличие не подтверждено</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.displayName} · {status[model.status]}</option>)}
      </select></label>}
    <button type="button" onClick={() => setRevision(value => value + 1)} disabled={disabled || !baseUrl.trim()}>Refresh · {side}</button>
    <div role="status" aria-label={`Список моделей · ${side}`}>
      {loading && <p className="hint">Загрузка моделей…</p>}
      {current?.error && <p className="error-text">{current.error}</p>}
      {current?.result && !models.length && <p className="hint">Модели не найдены. Обновите список или введите Model ID вручную.</p>}
      {current?.result?.warnings.map(warning => <p className="hint" key={warning}>{warning}</p>)}
      {selected && <p className="hint">{status[selected.status]}{selected.parameterSize ? ` · ${selected.parameterSize}` : ''}{selected.quantization ? ` · ${selected.quantization}` : ''}{selected.sizeBytes !== undefined ? ` · ${(selected.sizeBytes / 1024 ** 3).toFixed(2)} GiB` : ''}</p>}
    </div>
    {api === 'ollama' && <p className="hint">Список содержит скачанные модели. «В памяти» подтверждается отдельным /api/ps; получение списка не загружает модель.</p>}
    {api === 'vllm' && <p className="hint">Показаны модели, обслуживаемые этим сервером. HF Cache через API недоступен. Для другой модели настройте VLLM_MODEL_ID и пересоздайте runtime по инструкции README.</p>}
  </div>;
}
