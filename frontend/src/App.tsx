import { useState } from 'react';
import type { Experiment, MatchSnapshot } from './api/contracts';
import { useMatch } from './state/use-match';
import { Settings } from './components/Settings';
import { Experiments } from './components/Experiments';
import { MatchWorkspace } from './components/MatchWorkspace';
import { Modal } from './components/Modal';

export function App() {
  const arena = useMatch();
  const [page, setPage] = useState<'live' | 'archive'>('live');
  const [record, setRecord] = useState<Experiment | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stepMode, setStepMode] = useState(false);
  const snapshot = arena.snapshot;
  const canConfigure = !arena.pending && !!snapshot && !snapshot.busy && (snapshot.status === 'Created' || !!snapshot.result);
  async function replay(config: MatchSnapshot['config']) {
    if (!canConfigure) return;
    if (await arena.configure(config)) { setRecord(null); setPage('live'); }
  }
  return <main className="shell">
    <header className="app-header">
      <h1>LLM Chess <span>Arena</span></h1>
      <nav className="page-nav" aria-label="Разделы"><button onClick={() => { setPage('live'); setRecord(null); }} aria-pressed={page === 'live'}>Текущий матч</button><button onClick={() => { setPage('archive'); setRecord(null); }} aria-pressed={page === 'archive'}>История экспериментов</button></nav>
      <div className="connection"><span className={`dot ${arena.connection === 'SSE подключён' ? 'connected' : ''}`} /><span data-testid="connection">{arena.connection}</span><button className="text-button" onClick={arena.reconnect}>Переподключить</button></div>
      <button onClick={() => setSettingsOpen(true)} disabled={!snapshot} aria-haspopup="dialog"><span aria-hidden="true">⚙</span> Настройки</button>
    </header>
    {arena.error && <p className="error-banner" role="alert">{arena.error}</p>}
    <div className="page-content">
      {page === 'archive' && !record && <Experiments onSelect={setRecord} />}
      {page === 'archive' && record && <div className="archive-workspace"><div className="archive-toolbar"><button onClick={() => setRecord(null)}>К списку экспериментов</button>{!canConfigure && <p className="hint">Для повторного запуска сначала остановите текущий матч.</p>}</div>
        <MatchWorkspace key={record.id} archived canReplay={canConfigure} stepMode={stepMode} arena={{ ...arena, snapshot: { ...record.snapshot, statistics: record.statistics }, events: record.events }} onReplay={() => { void replay(record.snapshot.config); }} /></div>}
      <div hidden={page !== 'live'} className="live-workspace">{snapshot ? <MatchWorkspace archived={snapshot.archived ?? false} canReplay={canConfigure} stepMode={stepMode} arena={{ ...arena, snapshot }} onReplay={() => { void replay(snapshot.config); }} /> : <section className="panel loading"><h2>Подготовка арены</h2><p>Загружаем состояние матча с сервера…</p></section>}</div>
    </div>
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Настройки эксперимента" drawer>
      {snapshot && <Settings key={snapshot.id} config={snapshot.config} initialStep={stepMode} disabled={!canConfigure || !!snapshot.archived} onSave={(config, step) => {
        void arena.configure(config).then(saved => { if (saved) { setStepMode(step); setSettingsOpen(false); } });
      }} />}
      {arena.error && <p role="alert" className="error-banner">{arena.error}</p>}
    </Modal>
  </main>;
}
