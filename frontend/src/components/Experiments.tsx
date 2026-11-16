import { useEffect, useRef, useState } from 'react';
import type { Experiment, ExperimentSummary } from '../api/contracts';
import { getExperiment, listExperiments } from '../api/matches';

export function Experiments({ onSelect }: { onSelect: (record: Experiment) => void }) {
  const [rows, setRows] = useState<ExperimentSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [unreadable, setUnreadable] = useState(0);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const selection = useRef<AbortController | null>(null);
  useEffect(() => () => selection.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void listExperiments(offset, controller.signal).then(page => {
      setRows(page.experiments); setTotal(page.total); setUnreadable(page.unreadableFiles); setError('');
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось загрузить архив'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, refresh]);
  async function select(id: string) {
    selection.current?.abort();
    const controller = new AbortController(); selection.current = controller;
    try { const record = await getExperiment(id, controller.signal); if (!controller.signal.aborted) onSelect(record); }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось открыть партию'); }
  }
  return <section className="panel archive" aria-label="История экспериментов">
    <div className="panel-title"><h2>История экспериментов</h2><button onClick={() => { setLoading(true); setRefresh(value => value + 1); }}>Обновить архив</button></div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {unreadable > 0 && <p role="status">Повреждённых или неподдерживаемых файлов: {unreadable}. Остальные партии доступны.</p>}
    {loading && <p>Загрузка архива…</p>}
    {!loading && rows.length === 0 && <p>Сохранённых партий пока нет.</p>}
    <div className="experiment-list">{rows.map(row => <button className="experiment-row" key={row.id} onClick={() => { void select(row.id); }}>
      <span>{new Date(row.createdAt).toLocaleString('ru-RU')} · {row.id.slice(0, 8)}</span>
      <strong>{row.players.white} / {row.players.black}</strong>
      <span>{row.statistics.plies} полуходов · {row.result ? `${row.result.kind} / ${row.result.reason} / ${row.result.score}` : row.status}</span>
    </button>)}</div>
    <nav className="history-nav" aria-label="Страницы архива"><button disabled={offset === 0 || loading} onClick={() => { setLoading(true); setOffset(Math.max(0, offset - 25)); }}>Предыдущие партии</button>
      <span>{total ? offset + 1 : 0}–{Math.min(offset + 25, total)} / {total}</span>
      <button disabled={offset + 25 >= total || loading} onClick={() => { setLoading(true); setOffset(offset + 25); }}>Следующие партии</button></nav>
  </section>;
}
