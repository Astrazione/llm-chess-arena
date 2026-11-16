import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Color, MatchConfig, PlayerSettings, ProviderInfo, ProbeResult, Strategy } from '../api/contracts';
import { getProviderInfo, probeProvider } from '../api/matches';
import { connectionPresets } from '../api/connection-presets';
import { ModelPicker } from './ModelPicker';

const strategies: Record<Strategy, string> = {
  RandomLegalMove: 'Случайный легальный ход', ScriptedMoves: 'Сценарий UCI', InvalidMove: 'Недопустимые ходы',
  MalformedResponse: 'Ошибка формата', DelayedResponse: 'Медленный ответ',
};
export function Settings({ config, disabled, onSave, initialStep }: {
  config: MatchConfig; disabled: boolean; initialStep: boolean; onSave: (config: MatchConfig, step: boolean) => void;
}) {
  const [draft, setDraft] = useState(config);
  const [step, setStep] = useState(initialStep);
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [checks, setChecks] = useState<Partial<Record<Color, string>>>({});
  const [diagnostics, setDiagnostics] = useState<Partial<Record<Color, ProbeResult>>>({});
  const [checking, setChecking] = useState<Partial<Record<Color, boolean>>>({});
  const probes = useRef<Partial<Record<Color, AbortController>>>({});
  useEffect(() => {
    const controller = new AbortController();
    const active = probes.current;
    void getProviderInfo(controller.signal).then(setInfo).catch(() => { if (!controller.signal.aborted) setInfoError('Не удалось загрузить профили ключей и стандартный промпт'); });
    return () => { controller.abort(); Object.values(active).forEach(probe => probe.abort()); };
  }, []);
  function replacePlayer(color: Color, settings: PlayerSettings) {
    probes.current[color]?.abort();
    delete probes.current[color];
    setChecking(current => ({ ...current, [color]: false }));
    setChecks(current => ({ ...current, [color]: '' }));
    setDiagnostics(current => ({ ...current, [color]: undefined }));
    setDraft(current => ({ ...current, players: { ...current.players, [color]: settings } }));
  }
  function player(color: Color, patch: Partial<PlayerSettings>) {
    replacePlayer(color, { ...draft.players[color], ...patch } as PlayerSettings);
  }
  async function check(color: Color) {
    probes.current[color]?.abort();
    const controller = new AbortController();
    probes.current[color] = controller;
    setChecking(current => ({ ...current, [color]: true }));
    setChecks(current => ({ ...current, [color]: 'Проверяем модель…' }));
    setDiagnostics(current => ({ ...current, [color]: undefined }));
    const timer = setTimeout(() => controller.abort(), (draft.players[color].timeoutMs ?? 1000) + 5000);
    try {
      const result = await probeProvider(draft.players[color], controller.signal);
      if (!controller.signal.aborted) {
        setChecks(current => ({ ...current, [color]: result.available ? `Модель доступна. ${result.diagnostic}` : `Ошибка: ${result.diagnostic}` }));
        setDiagnostics(current => ({ ...current, [color]: result }));
      }
    } catch (error) {
      if (!controller.signal.aborted) setChecks(current => ({ ...current, [color]: error instanceof Error ? error.message : 'Ошибка подключения' }));
    } finally {
      clearTimeout(timer);
      if (probes.current[color] === controller) {
        setChecking(current => ({ ...current, [color]: false }));
        if (controller.signal.aborted) setChecks(current => ({ ...current, [color]: 'Проверка отменена или истёк тайм-аут' }));
      }
    }
  }
  function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSave(draft, step); }
  return <details className="panel settings" open>
    <summary>Настройки эксперимента <span className="muted">Mock / Chat Completions</span></summary>
    <form onSubmit={save}>
      <fieldset disabled={disabled}>
        {infoError && <p className="error-text">{infoError}</p>}
        <div className="player-settings">
          {(['white', 'black'] as const).map(color => {
            const settings = draft.players[color];
            const side = color === 'white' ? 'белые' : 'чёрные';
            return <div key={color}>
              <h3>{color === 'white' ? 'Белые' : 'Чёрные'}</h3>
              <label>Провайдер · {side}<select aria-label={`Провайдер · ${side}`} value={settings.provider ?? 'mock'} onChange={e => replacePlayer(color, e.target.value === 'mock'
                ? { provider: 'mock', strategy: 'RandomLegalMove', seed: 1, ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}) }
                : { provider: 'openai-compatible', providerName: 'OpenAI-compatible', discoveryApi: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1', modelId: '', timeoutMs: 60000, tokenLimitParameter: 'max_tokens', responseFormat: 'text', ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}) })}>
                <option value="mock">Mock Provider</option><option value="openai-compatible">OpenAI-compatible API</option>
              </select></label>
              {settings.provider === 'openai-compatible' ? <>
                <label>Подключение · {side}<select aria-label={`Подключение · ${side}`} value="" onChange={e => {
                  const preset = connectionPresets[e.target.value as keyof typeof connectionPresets];
                  if (!preset) return;
                  const next = { ...settings, providerName: preset.name, baseUrl: preset.baseUrl, discoveryApi: preset.discoveryApi };
                  delete next.credentialProfile;
                  replacePlayer(color, next);
                }}><option value="">Выбрать шаблон адреса…</option>{Object.entries(connectionPresets).map(([id, preset]) => <option key={id} value={id}>{preset.name}</option>)}</select></label>
                <p className="hint">Выберите модель из списка или включите ручной ввод. Base URL можно изменить для любого подключения.</p>
                <label>Название провайдера · {side}<input required maxLength={128} value={settings.providerName} onChange={e => player(color, { providerName: e.target.value })} /></label>
                <label>Base URL · {side}<input required type="url" value={settings.baseUrl} onChange={e => player(color, { baseUrl: e.target.value })} /></label>
                <ModelPicker settings={settings} side={side} disabled={disabled} onChange={patch => player(color, patch)} />
                <label>Профиль ключа · {side}<select aria-label={`Профиль ключа · ${side}`} value={settings.credentialProfile ?? ''} onChange={e => {
                  const profile = info?.profiles.find(item => item.id === e.target.value);
                  if (profile) player(color, { credentialProfile: profile.id, baseUrl: profile.baseUrl });
                  else { const next = { ...settings }; delete next.credentialProfile; replacePlayer(color, next); }
                }}><option value="">Без ключа</option>{info?.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.id}</option>)}</select></label>
                <label>Temperature · {side}<input type="number" min="0" max="2" step="0.01" placeholder="Не отправлять" value={settings.temperature ?? ''} onChange={e => {
                  if (e.target.value === '') { const next = { ...settings }; delete next.temperature; replacePlayer(color, next); }
                  else player(color, { temperature: Number(e.target.value) });
                }} /></label>
                <label>Лимит токенов · {side}<input type="number" min="1" max="131072" placeholder="Лимит сервера" value={settings.maxOutputTokens ?? ''} onChange={e => {
                  if (e.target.value === '') { const next = { ...settings }; delete next.maxOutputTokens; replacePlayer(color, next); }
                  else player(color, { maxOutputTokens: Number(e.target.value) });
                }} /></label>
                <label>Параметр лимита · {side}<select aria-label={`Параметр лимита · ${side}`} value={settings.tokenLimitParameter} onChange={e => player(color, { tokenLimitParameter: e.target.value as 'max_tokens' | 'max_completion_tokens' })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
                <label>Формат API · {side}<select aria-label={`Формат API · ${side}`} value={settings.responseFormat} onChange={e => player(color, { responseFormat: e.target.value as 'text' | 'json_object' })}><option value="text">Текст → JSON Parser</option><option value="json_object">JSON mode</option></select></label>
                <details className="advanced"><summary>Воспроизводимость · {side}</summary>
                  <label>Seed API · {side}<input type="number" min="0" max="4294967295" placeholder="Не отправлять" value={settings.seed ?? ''} onChange={e => {
                    const next = { ...settings }; if (e.target.value === '') delete next.seed; else next.seed = Number(e.target.value); replacePlayer(color, next);
                  }} /></label>
                  {(['runtime', 'runtimeVersion', 'modelRevision', 'quantization'] as const).map((key, index) => <label key={key}>{['Inference runtime', 'Версия runtime', 'Ревизия модели', 'Квантование'][index]} · {side}<input maxLength={key === 'modelRevision' ? 256 : 128} value={settings[key] ?? ''} onChange={e => {
                    const next = { ...settings }; if (e.target.value) next[key] = e.target.value; else delete next[key]; replacePlayer(color, next);
                  }} /></label>)}
                  <label>Контекст модели · {side}<input type="number" min="1" value={settings.maxContextTokens ?? ''} onChange={e => {
                    const next = { ...settings }; if (e.target.value) next.maxContextTokens = Number(e.target.value); else delete next.maxContextTokens; replacePlayer(color, next);
                  }} /></label>
                  <p className="hint">Seed отправляется только при явном выборе. Поддержка зависит от API. Одинаковый seed не гарантирует одинаковые ответы на разных GPU, версиях runtime и провайдерах. Метаданные описывают запуск и не меняют настройки сервера.</p>
                </details>
              </> : <>
                <label>Модель · {side}<select aria-label={`Модель · ${side}`} value={settings.strategy} onChange={e => player(color, { strategy: e.target.value as Strategy, invalidEvery: 1 })}>
                  {Object.entries(strategies).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select></label>
                <label>Seed · {side}<input type="number" min="0" max="4294967295" required value={settings.seed ?? 1} onChange={e => player(color, { seed: Number(e.target.value) })} /></label>
                <label>Время ответа, мс · {side}<input type="number" min="0" max="60000" required value={settings.delayMs ?? 0} onChange={e => player(color, { delayMs: Number(e.target.value), timeoutMs: 30000 })} /></label>
                {settings.strategy === 'ScriptedMoves' && <label>Ходы UCI · {side}<input required placeholder="e2e4 g1f3" value={settings.moves?.join(' ') ?? ''} onChange={e => player(color, { moves: e.target.value.split(/\s+/).filter(Boolean) })} /></label>}
                {settings.strategy === 'InvalidMove' && <label>Ошибка каждые N попыток · {side}<input type="number" min="1" max="1000" required value={settings.invalidEvery ?? 1} onChange={e => player(color, { invalidEvery: Number(e.target.value) })} /></label>}
              </>}
              <label>Тайм-аут, мс · {side}<input type="number" min="1" max={settings.provider === 'openai-compatible' ? 300000 : 30000} required value={settings.timeoutMs ?? 1000} onChange={e => player(color, { timeoutMs: Number(e.target.value) })} /></label>
              <details className="advanced"><summary>Промпт · {side}</summary>
                <label>Системный промпт · {side}<textarea rows={5} maxLength={16000} placeholder="Использовать общий шаблон" value={settings.systemPrompt ?? ''} onChange={e => {
                  if (!e.target.value) { const next = { ...settings }; delete next.systemPrompt; replacePlayer(color, next); }
                  else player(color, { systemPrompt: e.target.value });
                }} /></label>
                <button type="button" disabled={!info} onClick={() => player(color, { systemPrompt: info!.defaultSystemPrompt })}>Стандартный промпт · {side}</button>
              </details>
              <button type="button" disabled={checking[color] || (settings.provider === 'openai-compatible' && !settings.modelId.trim())} onClick={() => { void check(color); }}>Проверить модель · {side}</button>
              {checks[color] && <p className="hint" role="status" aria-label={`Проверка · ${side}`}>{checks[color]}</p>}
              {diagnostics[color] && <div className="hint" aria-label={`Диагностика · ${side}`}>
                <p>Время ответа: {diagnostics[color].metrics.responseTimeMs === null ? 'нет данных' : `${Math.round(diagnostics[color].metrics.responseTimeMs)} мс`}</p>
                <p>Модель в ответе: {String(diagnostics[color].diagnostics?.reportedModel ?? 'нет данных')}</p>
                <p>Контекст сервера: {String(diagnostics[color].diagnostics?.reportedMaxContextTokens ?? 'нет данных')}</p>
                {diagnostics[color].diagnostics?.resourceError === 'OutOfMemory' && <p className="error-text">Runtime сообщил о нехватке памяти.</p>}
              </div>}
            </div>;
          })}
        </div>
        <p className="hint">Проверка модели и первый запуск отправляют тестовые запросы с выбранными параметрами. Облачный API может списать токены. Пустые temperature и лимит не передаются. Ключи настраиваются на сервере.</p>
        <div className="form-grid">
          <label>Максимум полуходов<input type="number" min="1" max="2000" required value={draft.maxPlies} onChange={e => setDraft({ ...draft, maxPlies: Number(e.target.value) })} /></label>
          <label>Повторных попыток<input type="number" min="0" max="10" required value={draft.maxRetries} onChange={e => setDraft({ ...draft, maxRetries: Number(e.target.value) })} /></label>
          <label>Между ходами, мс<input type="number" min="0" max="60000" required value={draft.moveDelayMs} onChange={e => setDraft({ ...draft, moveDelayMs: Number(e.target.value) })} /></label>
          <label>Режим игры<select aria-label="Режим игры" value={step ? 'step' : 'auto'} onChange={e => setStep(e.target.value === 'step')}><option value="auto">Автоматический</option><option value="step">Пошаговый</option></select></label>
        </div>
        <label>Передача позиции<select aria-label="Передача позиции" value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as 'A' | 'B' })}><option value="A">A · Без допустимых ходов</option><option value="B">B · С допустимыми ходами</option></select></label>
        <details className="advanced"><summary>Общая системная инструкция</summary>
          <label>Системный промпт<textarea rows={5} required maxLength={16000} value={draft.systemPrompt} onChange={e => setDraft({ ...draft, systemPrompt: e.target.value })} /></label>
          <button type="button" disabled={!info} onClick={() => setDraft({ ...draft, systemPrompt: info!.defaultSystemPrompt })}>Восстановить стандартный шаблон</button>
          <p className="hint">Переменные: {'{{color}}, {{fen}}, {{ascii}}, {{history}}'}. Пустой промпт игрока использует общий шаблон. Чужие ответы не включаются в контекст.</p>
        </details>
        <button type="submit" className="secondary" disabled={Object.values(checking).some(Boolean)}>Применить настройки</button>
      </fieldset>
      <p className="hint">Применение создаёт новый матч. Reset начинает новую партию с текущими настройками. Во время игры настройки заблокированы.</p>
    </form>
  </details>;
}
