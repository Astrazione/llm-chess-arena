import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, MatchConfig, MatchSnapshot, StreamUpdate } from '../api/contracts';
import { ApiError, commandMatch, createMatch, getEvents, getMatch } from '../api/matches';
import { emptyView, mergeView } from './match-state';

export function useMatch() {
  const [view, setView] = useState(emptyView);
  const [connection, setConnection] = useState('Инициализация');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Command | 'configure' | null>(null);
  const [retry, setRetry] = useState(0);
  const commandVersion = useRef(0);
  const id = view.snapshot?.id;
  const apply = useCallback((snapshot: MatchSnapshot) => {
    setView(current => current.snapshot?.id && current.snapshot.id !== snapshot.id ? { snapshot, events: [] } : mergeView(current, snapshot));
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function initialize() {
      try {
        const saved = sessionStorage.getItem('arena-match');
        let snapshot: MatchSnapshot;
        const defaults = { moveDelayMs: 600, players: { white: { strategy: 'RandomLegalMove' as const, seed: 1, delayMs: 300, timeoutMs: 30000 }, black: { strategy: 'RandomLegalMove' as const, seed: 2, delayMs: 300, timeoutMs: 30000 } } };
        try { snapshot = saved ? await getMatch(saved, controller.signal) : await createMatch(defaults, controller.signal); }
        catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          snapshot = await createMatch(defaults, controller.signal);
        }
        if (active) { sessionStorage.setItem('arena-match', snapshot.id); apply(snapshot); setError(null); }
      } catch (err) {
        if (active) { setConnection('Нет соединения'); setError(err instanceof Error ? err.message : 'Не удалось загрузить матч'); }
      }
    }
    void initialize();
    return () => { active = false; controller.abort(); };
  }, [apply, retry]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let active = true;
    let cursor = 0;
    let recovering = false;
    let streamOpen = false;
    async function recover() {
      if (recovering) return;
      recovering = true;
      try {
        // REST after every connection/reconnection is intentional: EventSource's
        // cursor alone cannot recover a missing journal or a changed gameId.
        let snapshot = await getMatch(id!, controller.signal);
        while (active) {
          const page = await getEvents(id!, cursor, controller.signal);
          if (page.events.length) cursor = page.events.at(-1)!.sequence;
          if (active) setView(current => mergeView(current, snapshot, page.events));
          if (!page.hasMore) break;
        }
        snapshot = await getMatch(id!, controller.signal);
        if (active && navigator.onLine && streamOpen) { setView(current => mergeView(current, snapshot)); setConnection('SSE подключён'); setError(null); }
      } catch (err) {
        if (active) {
          setConnection('Восстановление соединения');
          setError(err instanceof ApiError && err.status === 404 ? 'Backend перезапущен: матч больше не хранится. Нажмите «Переподключить».' : 'Не удалось восстановить состояние матча');
        }
      } finally { recovering = false; }
    }
    function connect() {
      const source = new EventSource(`/api/matches/${id}/stream`);
      source.onopen = () => { streamOpen = true; void recover(); };
      source.onerror = () => {
        streamOpen = false;
        if (active) {
          setConnection('Восстановление соединения');
          // A restarted RAM backend returns 404 before SSE can open. Diagnose
          // that through REST as well; onopen alone would never run.
          if (navigator.onLine) void recover();
        }
      };
      source.addEventListener('snapshot', message => {
        if (active) setView(current => mergeView(current, JSON.parse((message as MessageEvent<string>).data) as MatchSnapshot));
      });
      source.addEventListener('match', message => {
        const update = JSON.parse((message as MessageEvent<string>).data) as StreamUpdate;
        if (active && update.schemaVersion === 1) setView(current => mergeView(current, update.snapshot, [update.event]));
      });
      return source;
    }
    let stream = connect();
    const offline = () => { streamOpen = false; stream.close(); setConnection('Восстановление соединения'); };
    const online = () => { stream.close(); stream = connect(); };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      active = false; controller.abort(); stream.close();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [id, retry]);

  async function run(command: Command) {
    if (!id) return;
    const version = ++commandVersion.current;
    setPending(command); setError(null);
    try {
      const players = view.snapshot?.config.players;
      const budget = players ? Object.values(players).reduce((sum, player) => sum + (player.timeoutMs ?? 1000), 0) +
        (view.snapshot!.config.maxRetries + 1) * (players[view.snapshot!.position.turn].timeoutMs ?? 1000) + 10000 : 65000;
      const snapshot = await commandMatch(id, command, command === 'next-move' ? Math.max(65000, budget) : 65000);
      if (version === commandVersion.current) apply(snapshot);
    }
    catch (err) {
      // A reset may supersede an in-flight Next Move. Never retry a command
      // automatically: a lost response could otherwise execute another move.
      if (version === commandVersion.current) {
        setError(err instanceof Error ? err.message : 'Ошибка команды');
        try { apply(await getMatch(id)); } catch { /* Keep the last authoritative snapshot. */ }
      }
    } finally { if (version === commandVersion.current) setPending(null); }
  }
  async function configure(config: Partial<MatchConfig>) {
    setPending('configure'); setError(null);
    try {
      const snapshot = await createMatch(config);
      sessionStorage.setItem('arena-match', snapshot.id);
      apply(snapshot);
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка конфигурации'); }
    finally { setPending(null); }
  }
  return { ...view, connection, error, pending, run, configure, reconnect: () => setRetry(value => value + 1) };
}
