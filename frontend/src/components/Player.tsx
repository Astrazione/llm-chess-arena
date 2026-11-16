import type { Color, MatchSnapshot } from '../api/contracts';

export function Player({ color, snapshot }: { color: Color; snapshot: MatchSnapshot }) {
  const active = snapshot.position.turn === color && !snapshot.result;
  const attempts = snapshot.attempts.filter(attempt => attempt.color === color);
  const last = attempts.filter(attempt => attempt.elapsedMs !== null).at(-1);
  const waiting = attempts.some(attempt => attempt.status === 'Pending');
  const error = attempts.at(-1)?.status === 'Rejected';
  const moves = snapshot.position.history.filter(move => move.color === color).length;
  const settings = snapshot.config.players[color];
  const model = settings.provider === 'openai-compatible' ? settings.modelId : settings.strategy;
  const reported = attempts.filter(attempt => attempt.metrics?.totalTokens !== null && attempt.metrics?.totalTokens !== undefined);
  const totalTokens = reported.reduce((sum, attempt) => sum + attempt.metrics!.totalTokens!, 0);
  const check = snapshot.providerChecks?.find(item => item.color === color)?.result;
  const status = snapshot.result ? 'Завершено' : waiting ? 'Ожидание ответа' : error ? 'Ошибка ответа' : active ? (snapshot.status === 'Paused' ? 'Пауза' : 'Очередь хода') : 'Ожидание хода';
  return <section aria-label={`Игрок: ${color === 'white' ? 'белые' : 'чёрные'}`} className={`player ${active ? 'active' : ''}`}>
    <span className={`piece-avatar ${color}`} aria-hidden="true">{color === 'white' ? '♔' : '♚'}</span>
    <div className="player-name"><span className="eyebrow">{color === 'white' ? 'Белые' : 'Чёрные'} · {settings.provider === 'openai-compatible' ? settings.providerName : 'Mock Provider'}</span><strong title={model}>{model}</strong><span className={waiting ? 'accent' : 'muted'}>{status}</span><span className="muted">Токены ходов: {reported.length ? `${totalTokens}${reported.length < attempts.length ? ' (частично)' : ''}` : '—'}</span></div>
    <dl className="player-stats"><div><dt>Ходы</dt><dd>{moves}</dd></div><div><dt>Ошибки</dt><dd>{attempts.filter(attempt => attempt.error).length}</dd></div><div><dt>Ответ</dt><dd>{last ? `${Math.round(last.elapsedMs!)} мс` : '—'}</dd></div></dl>
    {settings.provider === 'openai-compatible' && check && <details className="hint"><summary>Inference endpoint: {check.available ? 'доступен при проверке' : 'ошибка проверки'}</summary>
      <p>{check.diagnostic}</p>
      <p>Модель в ответе: {String(last?.diagnostics?.reportedModel ?? check.diagnostics?.reportedModel ?? 'нет данных')}</p>
      <p>Контекст сервера: {String(check.diagnostics?.reportedMaxContextTokens ?? 'нет данных')}</p>
      {check.diagnostics?.resourceError === 'OutOfMemory' && <p className="error-text">Runtime сообщил о нехватке памяти.</p>}
    </details>}
  </section>;
}
