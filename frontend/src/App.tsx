import { useEffect, useState } from 'react';
import { checkHealth } from './api/health';

type Connection =
  | { status: 'checking' }
  | { status: 'connected' }
  | { status: 'error'; message: string };

export function App() {
  const [connection, setConnection] = useState<Connection>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(controller.signal).then(
      () => { if (!controller.signal.aborted) setConnection({ status: 'connected' }); },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setConnection({ status: 'error', message: error instanceof Error ? error.message : 'Ошибка соединения' });
        }
      },
    );
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    setConnection({ status: 'checking' });
    setAttempt(value => value + 1);
  }

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Эксперименты с языковыми моделями</p>
        <h1>LLM Chess Arena</h1>
        <p className="intro">Локальная среда для шахматных матчей между двумя LLM.</p>
      </header>

      <section className="card" aria-labelledby="connection-heading">
        <span className="stage">Этап 1 · Окружение</span>
        <h2 id="connection-heading">Соединение с сервером</h2>
        <div role="status" aria-live="polite" className={`connection ${connection.status}`}>
          <span className="dot" aria-hidden="true" />
          {connection.status === 'checking' && 'Проверяем соединение…'}
          {connection.status === 'connected' && 'Backend подключён'}
          {connection.status === 'error' && 'Backend недоступен'}
        </div>
        {connection.status === 'connected' && <p>Сервер отвечает. Окружение готово к дальнейшей разработке.</p>}
        {connection.status === 'error' && <p role="alert">{connection.message}</p>}
        <button type="button" onClick={retry} disabled={connection.status === 'checking'}>
          Проверить снова
        </button>
      </section>

      <p className="note">Следующий этап — шахматный движок и тестирование правил игры.</p>
    </main>
  );
}
