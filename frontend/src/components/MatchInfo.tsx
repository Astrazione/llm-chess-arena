import { useEffect, useId, useRef, useState } from 'react';
import type { GameEvent, MatchSnapshot } from '../api/contracts';
import { EventLog } from './EventLog';
import { Statistics } from './Statistics';
import { Tabs } from './Tabs';

const resultReasons: Record<string, string> = {
  Checkmate: 'Мат', Stalemate: 'Пат', InsufficientMaterial: 'Недостаточно материала', FivefoldRepetition: 'Пятикратное повторение',
  SeventyFiveMoves: 'Правило 75 ходов', ThreefoldRepetition: 'Троекратное повторение', FiftyMoves: 'Правило 50 ходов',
  MaxPlies: 'Достигнут лимит полуходов', UserStop: 'Остановлено пользователем', ServerShutdown: 'Сервер остановлен', Reset: 'Сброс',
};
export function MatchInfo({ snapshot, events, selected, onSelect, phase, fen, stepMode }: {
  snapshot: MatchSnapshot; events: GameEvent[]; selected: number; onSelect: (ply: number) => void; phase: string; fen: string; stepMode: boolean;
}) {
  const [tab, setTab] = useState<'overview' | 'moves' | 'log'>('overview');
  const moves = useRef<HTMLDivElement>(null);
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const history = snapshot.position.history;
  const instance = useId();
  useEffect(() => {
    if (tab === 'moves') moves.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, tab, history.length]);
  const last = history.at(-1);
  const attempt = snapshot.attempts.at(-1);
  const important = [...events].reverse().find(event => !['OperationSettled', 'MoveRequested', 'ProviderCheckRequested'].includes(event.type));
  const prefix = `match-${snapshot.id}-${instance}`;
  return <aside className="info-column panel">
    <div className="info-heading"><div><span className="eyebrow">Матч / {snapshot.id.slice(0, 8)}</span><h2>Информация о партии</h2></div>
      <details className="export-menu" ref={exportMenu} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>Экспорт ▾</summary><div onClick={() => { if (exportMenu.current) exportMenu.current.open = false; }}><a href={`/api/experiments/${snapshot.gameId}/export.pgn`} download>Скачать PGN</a><a href={`/api/experiments/${snapshot.gameId}/export.json`} download>Скачать JSON</a></div></details>
    </div>
    <div className="match-glance"><span>{phase}</span><span className={snapshot.attempts.some(item => item.error) ? 'error-text' : ''}>Ошибки: {snapshot.attempts.filter(item => item.error).length}</span><strong>Последний ход: {last ? `${Math.ceil(last.ply / 2)}. ${last.san}` : '-'}</strong></div>
    <Tabs label="Информация о партии" prefix={prefix} items={[{ id: 'overview', label: 'Обзор' }, { id: 'moves', label: 'Ходы' }, { id: 'log', label: 'Журнал' }]} value={tab} onChange={setTab} />
    <div className="tab-content" role="tabpanel" id={`${prefix}-panel-overview`} aria-labelledby={`${prefix}-tab-overview`} hidden={tab !== 'overview'} tabIndex={0}>
      {snapshot.storageError && <p role="alert" className="error-banner">{snapshot.storageError}</p>}
      <section className="stats-strip" aria-label="Статистика партии"><div><span>Полуходы</span><strong>{history.length}<small> / {snapshot.config.maxPlies}</small></strong></div><div><span>Ошибки</span><strong>{snapshot.attempts.filter(item => item.error).length}</strong></div><div><span>Повторы</span><strong>{snapshot.attempts.filter(item => item.attemptNumber > 1).length}</strong></div><div><span>Длительность</span><strong>{snapshot.statistics?.durationMs == null ? '-' : `${(snapshot.statistics.durationMs / 1000).toFixed(1)} с`}</strong></div></section>
      <div className="overview-event"><h3>Последнее событие</h3><p className={attempt?.error ? 'error-text' : ''}>{attempt?.error ? `${attempt.error.code}: ${attempt.error.message}` : important?.data.move ? `Ход ${important.data.move.san} принят` : important?.data.message ?? phase}</p></div>
      {snapshot.result && <div className="result-summary"><h3>Результат · {snapshot.result.score}</h3><p>{snapshot.result.kind === 'TechnicalLoss' ? 'Техническое поражение · ' : ''}{resultReasons[snapshot.result.reason] ?? snapshot.result.reason}</p></div>}
      {snapshot.statistics && <details className="statistics-details" open><summary>Сравнение игроков и подробная статистика</summary><Statistics stats={snapshot.statistics} /></details>}
      <details className="advanced"><summary>Токены и диагностика игроков</summary>{(['white', 'black'] as const).map(color => {
        const attempts = snapshot.attempts.filter(item => item.color === color);
        const reported = attempts.filter(item => item.metrics?.totalTokens != null);
        const check = snapshot.providerChecks?.find(item => item.color === color)?.result;
        const diagnostics = attempts.at(-1)?.diagnostics ?? check?.diagnostics;
        return <div key={color}><h3>{color === 'white' ? 'Белые' : 'Чёрные'}</h3><p>Токены ходов: {reported.length ? `${reported.reduce((sum, item) => sum + item.metrics!.totalTokens!, 0)}${reported.length < attempts.length ? ' (частично)' : ''}` : '-'}</p>{check && <p>Inference endpoint: {check.available ? 'доступен при проверке' : 'ошибка проверки'}. {check.diagnostic}</p>}{diagnostics && <pre>{JSON.stringify(diagnostics, null, 2)}</pre>}</div>;
      })}</details>
      <details className="fen-details"><summary>FEN позиции</summary><code data-testid="fen">{fen}</code></details>
      <details className="advanced"><summary>Конфигурация эксперимента</summary><pre>{JSON.stringify(snapshot.config, null, 2)}</pre></details>
      <p className="hint">{stepMode ? 'Пошаговый' : 'Автоматический'} режим. Pause даёт текущему запросу завершиться. Next Move выполняет один ход с повторами и оставляет партию на паузе. Stop и Reset отменяют запрос.</p>
    </div>
    <div className="tab-content moves-content" role="tabpanel" id={`${prefix}-panel-moves`} aria-labelledby={`${prefix}-tab-moves`} hidden={tab !== 'moves'} ref={moves} tabIndex={0}>
      <div className="panel-title"><h2>История ходов</h2><span className="muted">SAN</span></div>
      <div className="move-history">{!history.length ? <p className="empty">Начальная позиция. Сделайте первый ход.</p> : Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => <div className="move-pair" key={index}><span>{index + 1}.</span>{history.slice(index * 2, index * 2 + 2).map(move => <button key={move.ply} aria-label={`Полуход ${move.ply}: ${move.san}`} aria-pressed={selected === move.ply} className={selected === move.ply ? 'selected' : ''} onClick={() => onSelect(move.ply)}>{move.san}</button>)}</div>)}</div>
    </div>
    <div className="tab-content log-content" role="tabpanel" id={`${prefix}-panel-log`} aria-labelledby={`${prefix}-tab-log`} hidden={tab !== 'log'}><EventLog events={events} visible={tab === 'log'} />
      {!!snapshot.providerChecks?.length && <details className="preflight-details"><summary>Проверки моделей перед матчем</summary><pre>{JSON.stringify(snapshot.providerChecks, null, 2)}</pre></details>}
    </div>
  </aside>;
}
