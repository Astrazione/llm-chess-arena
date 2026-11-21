import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Color, MatchConfig, PlayerSettings, ProviderInfo, ProbeResult } from '../api/contracts';
import { getProviderInfo, probeProvider } from '../api/matches';
import { Tabs } from './Tabs';
import { PlayerSettingsForm } from './PlayerSettingsForm';

export function Settings({ config, disabled, onSave, initialStep }: {
  config: MatchConfig; disabled: boolean; initialStep: boolean; onSave: (config: MatchConfig, step: boolean) => void;
}) {
  const [draft, setDraft] = useState(config);
  const [tab, setTab] = useState<'white' | 'black' | 'general'>('white');
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
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
    if (invalid) {
      setTab(invalid.closest<HTMLElement>('[data-settings-tab]')!.dataset.settingsTab as typeof tab);
      requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); });
      return;
    }
    onSave(draft, step);
  }
  return <div className="settings">
    <Tabs label="Настройки игроков и эксперимента" prefix="settings" items={[{ id: 'white', label: 'Белые' }, { id: 'black', label: 'Чёрные' }, { id: 'general', label: 'Общие' }]} value={tab} onChange={setTab} />
    <form onSubmit={save} noValidate>
      <div className="settings-scroll">
      {disabled && <p className="hint" role="status">Во время игры настройки заблокированы.</p>}
      <fieldset disabled={disabled}>
        {infoError && <p className="error-text">{infoError}</p>}
        {(['white', 'black'] as const).map(color => <div key={color} role="tabpanel" id={`settings-panel-${color}`} aria-labelledby={`settings-tab-${color}`} hidden={tab !== color} data-settings-tab={color}>
          <PlayerSettingsForm color={color} settings={draft.players[color]} disabled={disabled} info={info} player={player} replacePlayer={replacePlayer} checking={checking} check={check} checks={checks} diagnostics={diagnostics} />
        </div>)}
        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'} data-settings-tab="general">
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
        </div>
      </fieldset>
      </div>
      <div className="settings-actions">
        <button type="submit" className="primary" disabled={disabled || Object.values(checking).some(Boolean)}>Применить настройки</button>
        <p className="hint">Применение создаёт новый матч. Reset начинает новую партию с текущими настройками. Изменения полей не запускают матч.</p>
      </div>
    </form>
  </div>;
}
