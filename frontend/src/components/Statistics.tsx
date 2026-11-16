import type { ExperimentStatistics, PlayerStatistics } from '../api/contracts';

const resultNames = { Ongoing: 'Продолжается', ChessWin: 'Шахматная победа', Draw: 'Ничья', TechnicalLoss: 'Техническое поражение', Stopped: 'Принудительная остановка', Limit: 'Лимит полуходов' };
const time = (value: number | null) => value === null ? '—' : `${Math.round(value)} мс`;
const tokens = (value: number | null, samples: number, requests: number) => value === null ? '—' : `${value}${samples < requests ? ' (частично)' : ''}`;
export function Statistics({ stats }: { stats: ExperimentStatistics }) {
  const rows: [string, (player: PlayerStatistics) => string | number][] = [
    ['Успешные ходы', p => p.successfulMoves], ['Недопустимые ходы', p => p.illegalMoves], ['Ошибки формата / пустой ответ', p => p.formatErrors],
    ['Все ошибки', p => p.errors], ['Повторы', p => p.retries], ['Запросы ходов', p => p.requests],
    ['Доля допустимых ходов', p => p.legalMoveRatio === null ? '—' : `${(p.legalMoveRatio * 100).toFixed(1)}%`],
    ['Средний ответ', p => time(p.meanResponseMs)], ['Медианный ответ', p => time(p.medianResponseMs)],
    ['Входные токены', p => tokens(p.inputTokens, p.inputTokenSamples, p.requests)], ['Выходные токены', p => tokens(p.outputTokens, p.outputTokenSamples, p.requests)],
  ];
  return <section className="panel analytics" aria-label="Сравнение игроков">
    <h2>Сравнение игроков</h2><p>{resultNames[stats.resultCategory]} · {stats.plies} полуходов · {stats.totalRequests} запросов</p>
    <div className="table-scroll"><table><thead><tr><th>Показатель</th><th>Белые</th><th>Чёрные</th></tr></thead><tbody>
      {rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value(stats.players.white)}</td><td>{value(stats.players.black)}</td></tr>)}
    </tbody></table></div>
    <p className="hint">Длительность: {stats.durationMs === null ? '—' : `${(stats.durationMs / 1000).toFixed(1)} с`} (с паузами). Проверки API: {stats.preflightRequests}, их токены хранятся отдельно. Доля рассчитана по завершённым попыткам; отменённые и ожидающие исключены. «—» — нет данных.</p>
  </section>;
}
