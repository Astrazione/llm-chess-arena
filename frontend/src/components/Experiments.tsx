import { useEffect, useRef, useState } from 'react';
import type { Experiment, ExperimentSummary } from '../api/contracts';
import { clearHistory, getExperiment, listExperiments, previewHistoryCleanup } from '../api/matches';
import { Modal } from './Modal';

export function Experiments({ onSelect }: { onSelect: (record: Experiment) => void }) {
  const [rows, setRows] = useState<ExperimentSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [unreadable, setUnreadable] = useState(0);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const deletion = useRef<AbortController | null>(null);
  const selection = useRef<AbortController | null>(null);
  useEffect(() => () => { selection.current?.abort(); deletion.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([listExperiments(offset, controller.signal), previewHistoryCleanup(controller.signal)]).then(([page, preview]) => {
      setRows(page.experiments); setTotal(page.total); setUnreadable(page.unreadableFiles); setCandidates(preview.gameIds);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось загрузить архив'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, refresh]);
  async function remove() {
    if (!confirmation || deleting) return;
    const controller = new AbortController(); deletion.current = controller;
    setDeleting(true); setError(''); setNotice('');
    try {
      const result = await clearHistory(confirmation, controller.signal);
      if (!controller.signal.aborted) {
        setNotice(`Удалено партий: ${result.deleted}. Пропущено: ${result.skipped}.`);
        if (result.failed) setError(`Не удалось удалить партий: ${result.failed}. Проверьте доступность хранилища и повторите очистку.`);
      }
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось очистить историю'); }
    finally {
      if (!controller.signal.aborted) { setDeleting(false); setConfirmation(null); setLoading(true); setOffset(0); setRefresh(value => value + 1); }
    }
  }
  async function select(id: string) {
    selection.current?.abort();
    const controller = new AbortController(); selection.current = controller;
    try { const record = await getExperiment(id, controller.signal); if (!controller.signal.aborted) onSelect(record); }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Не удалось открыть партию'); }
  }
  return <section className="panel archive" aria-label="История экспериментов">
    <div className="panel-title"><h2>История экспериментов</h2><div className="archive-actions"><button disabled={loading || deleting} onClick={() => { setError(''); setLoading(true); setRefresh(value => value + 1); }}>Обновить архив</button><button className="danger" disabled={loading || deleting || !candidates.length} onClick={() => { setError(''); setConfirmation([...candidates]); }}>Очистить историю</button></div></div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {unreadable > 0 && <p role="status">Повреждённых или неподдерживаемых файлов: {unreadable}. Остальные партии доступны.</p>}
    {loading && <p>Загрузка архива…</p>}
    {!loading && rows.length === 0 && <p>Сохранённых партий пока нет.</p>}
    <div className="experiment-list">{rows.map(row => <button className="experiment-row" key={row.id} onClick={() => { void select(row.id); }}>
      <span>{new Date(row.createdAt).toLocaleString('ru-RU')} · {row.id.slice(0, 8)}</span>
      <strong>{row.players.white} / {row.players.black}</strong>
      <span>{row.statistics.plies} полуходов · {row.result ? `${row.result.kind} / ${row.result.reason} / ${row.result.score}` : row.status}</span>
    </button>)}</div>
    <nav className="history-nav archive-pagination" aria-label="Страницы архива"><button disabled={offset === 0 || loading} onClick={() => { setLoading(true); setOffset(Math.max(0, offset - 25)); }}>‹ Назад</button>
      <span>{total ? offset + 1 : 0}–{Math.min(offset + 25, total)} / {total}</span>
      <button disabled={offset + 25 >= total || loading} onClick={() => { setLoading(true); setOffset(offset + 25); }}>Вперёд ›</button></nav>
    <Modal open={confirmation !== null} onClose={() => setConfirmation(null)} title="Очистить историю?" busy={deleting}>
      <p>Будут удалены завершённые и остановленные партии: <strong>{confirmation?.length ?? 0}</strong>.</p>
      <p>Удаление необратимо. Данные активных партий сохраняются.</p>
      <div className="confirm-actions"><button disabled={deleting} onClick={() => setConfirmation(null)} autoFocus>Отмена</button><button className="danger" disabled={deleting} onClick={() => { void remove(); }}>{deleting ? 'Удаление…' : 'Удалить партии'}</button></div>
    </Modal>
  </section>;
}
