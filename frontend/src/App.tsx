import { useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Command, Experiment, MatchSnapshot } from './api/contracts';
import { allowedCommands, errorSquares } from './state/match-state';
import { useMatch } from './state/use-match';
import { Settings } from './components/Settings';
import { Player } from './components/Player';
import { EventLog } from './components/EventLog';
import { Statistics } from './components/Statistics';
import { Experiments } from './components/Experiments';

const statusNames = { Created: 'Готов к запуску', Running: 'Матч идёт', Paused: 'Пауза', Completed: 'Партия завершена', Stopped: 'Матч остановлен' };
const commandNames: Record<Command, string> = { start: 'Start', pause: 'Pause', resume: 'Resume', 'next-move': 'Next Move', stop: 'Stop', reset: 'Reset' };
const resultReasons: Record<string, string> = {
  Checkmate: 'Мат', Stalemate: 'Пат', InsufficientMaterial: 'Недостаточно материала', FivefoldRepetition: 'Пятикратное повторение',
  SeventyFiveMoves: 'Правило 75 ходов', ThreefoldRepetition: 'Троекратное повторение', FiftyMoves: 'Правило 50 ходов',
  MaxPlies: 'Достигнут лимит полуходов', UserStop: 'Остановлено пользователем', ServerShutdown: 'Сервер остановлен', Reset: 'Сброс',
};

function MatchWorkspace({ arena, archived = false, canReplay = true, onReplay }: { arena: ReturnType<typeof useMatch> & { snapshot: MatchSnapshot }; archived?: boolean; canReplay?: boolean; onReplay: () => void }) {
  const { snapshot, events, pending, run, configure } = arena;
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [selection, setSelection] = useState<{ gameId: string; ply: number } | null>(null);
  const [stepMode, setStepMode] = useState(false);
  const history = snapshot.position.history;
  const selected = selection?.gameId === snapshot.gameId ? Math.min(selection.ply, history.length) : history.length;
  const historical = selected < history.length;
  const fen = snapshot.position.positions[selected] ?? snapshot.position.fen;
  const lastMove = history[selected - 1];
  const latestAttempt = snapshot.attempts.at(-1);
  const failure = latestAttempt?.error ? latestAttempt : null;
  const styles: Record<string, CSSProperties> = {};
  if (lastMove) for (const square of [lastMove.uci.slice(0, 2), lastMove.uci.slice(2, 4)]) styles[square] = { backgroundColor: 'rgba(203, 198, 99, .48)' };
  if (!historical && failure) for (const square of errorSquares(failure.move, failure.rawText)) styles[square] = { boxShadow: 'inset 0 0 0 4px #ee8585', backgroundColor: 'rgba(202, 76, 76, .4)' };
  const allowed = allowedCommands(snapshot);
  function select(ply: number) { setSelection(ply === history.length ? null : { gameId: snapshot.gameId, ply }); }
  const pendingAttempt = snapshot.attempts.find(attempt => attempt.status === 'Pending');
  const phase = pendingAttempt ? 'Ожидание ответа модели' : snapshot.busy ? (snapshot.status === 'Paused' ? 'Завершение текущего запроса' : 'Подготовка следующего хода') : statusNames[snapshot.status];
  const errorCount = snapshot.attempts.filter(attempt => attempt.error).length;
  return <div className="workspace">
    <div className="board-column">
      <div className="board-heading"><div><span className="eyebrow">Матч / {snapshot.id.slice(0, 8)}</span><h2>{statusNames[snapshot.status]}</h2></div><button className="icon-button" onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')} aria-label="Перевернуть доску" title="Перевернуть доску">⇅</button></div>
      <Player color={orientation === 'white' ? 'black' : 'white'} snapshot={snapshot} />
      <div className="board-frame" role="img" aria-label={`Шахматная доска, ${historical ? `исторический полуход ${selected}` : 'текущая позиция'}`} data-fen={fen} data-orientation={orientation}>
        <Chessboard options={{ id: 'arena-board', position: fen, boardOrientation: orientation, allowDragging: false, allowDrawingArrows: false,
          darkSquareStyle: { backgroundColor: '#526a61' }, lightSquareStyle: { backgroundColor: '#d1d5c6' },
          squareStyles: styles, animationDurationInMs: 180, showAnimations: !historical,
        }} />
      </div>
      <Player color={orientation} snapshot={snapshot} />
      <div className={`position-state ${failure && !historical ? 'has-error' : ''}`} role="status" aria-label="Состояние партии">
        {historical ? `Просмотр истории · полуход ${selected} из ${history.length}` : phase}
        {!historical && snapshot.position.inCheck && <strong className="error-text"> · {snapshot.result?.reason === 'Checkmate' ? 'Мат' : 'Шах'}</strong>}
        {!historical && failure && <p>{failure.error?.code}: {failure.error?.message}</p>}
        {snapshot.result && <p>{snapshot.result.kind === 'TechnicalLoss' ? 'Техническое поражение · ' : ''}{resultReasons[snapshot.result.reason] ?? snapshot.result.reason} · {snapshot.result.score}</p>}
      </div>
      <nav className="history-nav" aria-label="Навигация по истории">
        <button onClick={() => select(0)} disabled={selected === 0} aria-label="Начало партии">|‹</button>
        <button onClick={() => select(selected - 1)} disabled={selected === 0} aria-label="Предыдущий ход">‹</button>
        <span>{selected} / <span data-testid="ply-count">{history.length}</span></span>
        <button onClick={() => select(selected + 1)} disabled={!historical} aria-label="Следующий ход">›</button>
        <button onClick={() => select(history.length)} disabled={!historical} aria-label="Последняя позиция">›|</button>
      </nav>
      {historical && <button className="return-live" onClick={() => select(history.length)}>К текущей позиции</button>}
      <details className="fen-details"><summary>FEN позиции</summary><code data-testid="fen">{fen}</code></details>
    </div>
    <aside className="info-column">
      {archived ? <section className="panel"><h2>Сохранённая партия</h2><p>Просмотр сохранённого снимка. Исходная партия остаётся в архиве.</p><button onClick={onReplay} disabled={pending !== null || !canReplay}>Новый эксперимент с этими настройками</button></section> : <section className="panel" aria-labelledby="controls-title"><div className="panel-title"><h2 id="controls-title">Управление матчем</h2><span className="badge">{stepMode ? 'Пошагово' : 'Автоматически'}</span></div>
        <div className="controls">{(Object.keys(commandNames) as Command[]).map(command => <button key={command} className={command === 'start' || command === 'resume' ? 'primary' : command === 'stop' ? 'danger' : 'secondary'} disabled={!allowed[command] || (pending !== null && command !== 'stop' && command !== 'reset')} onClick={() => { void run(command === 'start' && stepMode ? 'next-move' : command); }}>{commandNames[command]}{pending === command ? '…' : ''}</button>)}</div>
        <p className="hint">Pause даёт текущему запросу завершиться. Next Move выполняет один ход с повторами и оставляет партию на паузе. Stop и Reset отменяют запрос.</p>
      </section>}
      <section className="panel exports" aria-label="Экспорт партии"><h2>Экспорт партии</h2><a href={`/api/experiments/${snapshot.gameId}/export.pgn`} download>Скачать PGN</a><a href={`/api/experiments/${snapshot.gameId}/export.json`} download>Скачать JSON</a></section>
      {snapshot.storageError && <p role="alert" className="error-banner">{snapshot.storageError}</p>}
      <section className="stats-strip" aria-label="Статистика партии"><div><span>Полуходы</span><strong>{history.length}<small> / {snapshot.config.maxPlies}</small></strong></div><div><span>Ошибки</span><strong>{errorCount}</strong></div><div><span>Повторы</span><strong>{snapshot.attempts.filter(attempt => attempt.attemptNumber > 1).length}</strong></div></section>
      <section className="panel history-panel" aria-labelledby="history-title"><div className="panel-title"><h2 id="history-title">История ходов</h2><span className="muted">SAN</span></div>
        <div className="move-history">{history.length === 0 ? <p className="empty">Начальная позиция. Сделайте первый ход.</p> : Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => <div className="move-pair" key={index}><span>{index + 1}.</span>{history.slice(index * 2, index * 2 + 2).map(move => <button key={move.ply} aria-label={`Полуход ${move.ply}: ${move.san}`} aria-pressed={selected === move.ply} className={selected === move.ply ? 'selected' : ''} onClick={() => select(move.ply)}>{move.san}</button>)}</div>)}</div>
      </section>
      {snapshot.statistics && <Statistics stats={snapshot.statistics} />}
      {!!snapshot.providerChecks?.length && <details className="panel"><summary>Проверки моделей перед матчем</summary><pre>{JSON.stringify(snapshot.providerChecks, null, 2)}</pre></details>}
      {archived ? <details className="panel"><summary>Конфигурация эксперимента</summary><pre>{JSON.stringify(snapshot.config, null, 2)}</pre></details> : <Settings key={snapshot.id} config={snapshot.config} initialStep={stepMode} disabled={pending !== null || snapshot.busy || (snapshot.status !== 'Created' && !snapshot.result)} onSave={(config, step) => { setStepMode(step); void configure(config); }} />}
    </aside>
    <EventLog events={events} />
  </div>;
}

export function App() {
  const arena = useMatch();
  const [page, setPage] = useState<'live' | 'archive'>('live');
  const [record, setRecord] = useState<Experiment | null>(null);
  async function replay(config: MatchSnapshot['config']) {
    if (arena.snapshot && !arena.snapshot.result && arena.snapshot.status !== 'Created') return;
    if (await arena.configure(config)) { setRecord(null); setPage('live'); }
  }
  return <main className="shell">
    <header className="app-header"><div><p className="eyebrow">Лаборатория шахматных экспериментов</p><h1>LLM Chess <span>Arena</span></h1></div><div className="connection"><span className={`dot ${arena.connection === 'SSE подключён' ? 'connected' : ''}`} /><span data-testid="connection">{arena.connection}</span><button className="text-button" onClick={arena.reconnect}>Переподключить</button></div></header>
    {arena.error && <p className="error-banner" role="alert">{arena.error}</p>}
    <nav className="page-nav" aria-label="Разделы"><button onClick={() => { setPage('live'); setRecord(null); }} aria-pressed={page === 'live'}>Текущий матч</button><button onClick={() => { setPage('archive'); setRecord(null); }} aria-pressed={page === 'archive'}>История экспериментов</button></nav>
    {page === 'archive' && !record && <Experiments onSelect={setRecord} />}
    {page === 'archive' && record && <><button onClick={() => setRecord(null)}>К списку экспериментов</button>
      {arena.snapshot && !arena.snapshot.result && arena.snapshot.status !== 'Created' && <p className="hint">Для повторного запуска сначала остановите текущий матч.</p>}
      <MatchWorkspace key={record.id} archived canReplay={!arena.snapshot || !!arena.snapshot.result || arena.snapshot.status === 'Created'} arena={{ ...arena, snapshot: { ...record.snapshot, statistics: record.statistics }, events: record.events }} onReplay={() => { void replay(record.snapshot.config); }} /></>}
    {page === 'live' && (arena.snapshot ? <MatchWorkspace archived={arena.snapshot.archived ?? false} arena={{ ...arena, snapshot: arena.snapshot }} onReplay={() => { void replay(arena.snapshot!.config); }} /> : <section className="panel loading"><h2>Подготовка арены</h2><p>Загружаем состояние матча с сервера…</p></section>)}
    <footer>Локальный эксперимент · Mock / OpenAI-compatible <span>LLM Chess Arena / 5</span></footer>
  </main>;
}
