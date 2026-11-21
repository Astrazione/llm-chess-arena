import { useId, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Command, MatchSnapshot } from '../api/contracts';
import { allowedCommands, errorSquares } from '../state/match-state';
import type { useMatch } from '../state/use-match';
import { Player } from './Player';
import { MatchInfo } from './MatchInfo';

const statusNames = { Created: 'Готов к запуску', Running: 'Матч идёт', Paused: 'Пауза', Completed: 'Партия завершена', Stopped: 'Матч остановлен' };
const commandNames: Record<Command, string> = { start: 'Start', pause: 'Pause', resume: 'Resume', 'next-move': 'Next Move', stop: 'Stop', reset: 'Reset' };
const commandIcons: Record<Command, string> = { start: '▶', pause: 'Ⅱ', resume: '▷', 'next-move': '⏭', stop: '■', reset: '↺' };
const commandTips: Record<Command, string> = { start: 'Начать матч', pause: 'Приостановить после текущего запроса', resume: 'Продолжить матч', 'next-move': 'Один ход с повторами, затем пауза', stop: 'Остановить и отменить запрос', reset: 'Новая партия с текущими настройками' };

export function MatchWorkspace({ arena, archived = false, canReplay = true, stepMode, onReplay }: {
  arena: ReturnType<typeof useMatch> & { snapshot: MatchSnapshot }; archived?: boolean; canReplay?: boolean; stepMode: boolean; onReplay: () => void;
}) {
  const { snapshot, events, pending, run } = arena;
  const boardId = useId();
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [selection, setSelection] = useState<{ gameId: string; ply: number } | null>(null);
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
  return <div className="workspace">
    <div className="board-column">
      <div className="board-heading"><h2>{archived ? 'Сохранённая партия' : statusNames[snapshot.status]}</h2><button className="icon-button" onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')} aria-label="Перевернуть доску" title="Перевернуть доску">⇅</button></div>
      <Player color={orientation === 'white' ? 'black' : 'white'} snapshot={snapshot} />
      <div className="board-frame" role="img" aria-label={`Шахматная доска, ${historical ? `исторический полуход ${selected}` : 'текущая позиция'}`} data-fen={fen} data-orientation={orientation}>
        <Chessboard options={{ id: `arena-board-${boardId}`, position: fen, boardOrientation: orientation, allowDragging: false, allowDrawingArrows: false,
          darkSquareStyle: { backgroundColor: '#526a61' }, lightSquareStyle: { backgroundColor: '#d1d5c6' },
          squareStyles: styles, animationDurationInMs: 180, showAnimations: !historical,
        }} />
      </div>
      <Player color={orientation} snapshot={snapshot} />
      <div className={`position-state ${failure && !historical ? 'has-error' : ''}`} role="status" aria-label="Состояние партии" title={failure?.error?.message}>
        {historical ? `Просмотр истории · полуход ${selected} из ${history.length}` : phase}
        {!historical && snapshot.position.inCheck && <strong className="error-text"> · {snapshot.result?.reason === 'Checkmate' ? 'Мат' : 'Шах'}</strong>}
        {!historical && failure && <span> · {failure.error?.code}</span>}
        {snapshot.result && <span> · {snapshot.result.score}</span>}
      </div>
      {archived ? <button onClick={onReplay} disabled={pending !== null || !canReplay}>Новый эксперимент с этими настройками</button> : <section aria-label="Управление матчем" className="match-controls">
        <div className="controls">{(Object.keys(commandNames) as Command[]).map(command => <button key={command} aria-label={commandNames[command]} title={`${commandNames[command]} · ${commandTips[command]}`} className={command === 'start' || command === 'resume' ? 'primary' : command === 'stop' ? 'danger' : 'secondary'} disabled={!allowed[command] || (pending !== null && command !== 'stop' && command !== 'reset')} onClick={() => { void run(command === 'start' && stepMode ? 'next-move' : command); }}><span className="command-icon" aria-hidden="true">{pending === command ? '…' : commandIcons[command]}</span><span className="command-label">{commandNames[command]}</span></button>)}</div>
      </section>}
      <nav className="history-nav" aria-label="Навигация по истории">
        <button title="Начало партии" onClick={() => select(0)} disabled={selected === 0} aria-label="Начало партии">|‹</button>
        <button title="Предыдущий ход" onClick={() => select(selected - 1)} disabled={selected === 0} aria-label="Предыдущий ход">‹</button>
        <span>{selected} / <span data-testid="ply-count">{history.length}</span></span>
        <button title="Следующий ход" onClick={() => select(selected + 1)} disabled={!historical} aria-label="Следующий ход">›</button>
        <button title="Последняя позиция" onClick={() => select(history.length)} disabled={!historical} aria-label="Последняя позиция">›|</button>
        <button className="return-live" title="К текущей позиции" aria-label="К текущей позиции" onClick={() => select(history.length)} disabled={!historical}>Live</button>
      </nav>
    </div>
    <MatchInfo snapshot={snapshot} events={events} selected={selected} onSelect={select} phase={phase} fen={fen} stepMode={stepMode} />
  </div>;
}
