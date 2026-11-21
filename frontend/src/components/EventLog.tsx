import { useEffect, useId, useRef } from 'react';
import type { GameEvent } from '../api/contracts';

const labels: Record<GameEvent['type'], string> = {
  GameCreated: 'Партия создана', GameStarted: 'Матч начат', MoveRequested: 'Запрос хода', MoveAccepted: 'Ход выполнен',
  MoveRejected: 'Ответ отклонён', ProviderFailed: 'Ошибка провайдера', AttemptCancelled: 'Запрос отменён',
  GamePaused: 'Пауза', GameResumed: 'Игра возобновлена', GameCompleted: 'Партия завершена', GameStopped: 'Матч остановлен',
  GameReset: 'Новая партия после Reset', OperationSettled: 'Запрос завершён',
  ProviderCheckRequested: 'Проверка модели', ProviderChecked: 'Модель проверена',
};
export function EventLog({ events, visible = true }: { events: GameEvent[]; visible?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const titleId = useId();
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [events, visible]);
  return <section className="panel log-panel" aria-labelledby={titleId}>
    <div className="panel-title"><h2 id={titleId}>Журнал событий</h2><span className="muted">Текущая партия</span></div>
    <div className="event-log" ref={scroll} role="log" aria-live="off" onScroll={() => {
      const element = scroll.current;
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }}>
      {events.length === 0 && <p className="empty">События появятся после подключения.</p>}
      {events.filter(event => event.type !== 'OperationSettled').map(event => {
        const attempt = event.data.attempt;
        return <article className={`log-entry ${attempt?.error ? 'log-error' : ''}`} key={event.sequence}>
          <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('ru-RU')}</time>
          <div><strong>{labels[event.type]}{event.data.move ? ` · ${event.data.move.san}` : ''}{attempt && attempt.attemptNumber > 1 && event.type === 'MoveRequested' ? ` · повтор ${attempt.attemptNumber - 1}` : ''}</strong>
            {attempt && <p>{attempt.modelId} · полуход {attempt.ply} · попытка {attempt.attemptNumber}{attempt.elapsedMs !== null ? ` · ${Math.round(attempt.elapsedMs)} мс` : ''}</p>}
            {attempt?.metrics && attempt.status !== 'Pending' && <p>Токены: вход {attempt.metrics.inputTokens ?? '–'} / выход {attempt.metrics.outputTokens ?? '–'} / всего {attempt.metrics.totalTokens ?? '–'} · генерация {attempt.metrics.generationTimeMs === null ? '–' : `${Math.round(attempt.metrics.generationTimeMs)} мс`}{attempt.status === 'Accepted' && attempt.attemptNumber > 1 ? ' · исправлено моделью после повтора' : ''}</p>}
            {attempt?.error && <><p className="error-text">{attempt.error.code}: {attempt.error.message}</p><details open><summary>Ответ модели</summary><pre>{attempt.rawText ?? 'Ответ отсутствует'}</pre>{attempt.diagnostics && <pre>{JSON.stringify(attempt.diagnostics, null, 2)}</pre>}</details></>}
            {attempt && <details><summary>Запрос и ответ · попытка {attempt.id}</summary><pre>{JSON.stringify(attempt.request, null, 2)}</pre><pre>{attempt.rawText ?? 'Ответ отсутствует'}</pre>{attempt.diagnostics && <pre>{JSON.stringify(attempt.diagnostics, null, 2)}</pre>}</details>}
            {!attempt && event.data.message && <p>{event.data.message}</p>}
            {event.data.result && <p>{event.data.result.kind} · {event.data.result.reason} · {event.data.result.score}</p>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
