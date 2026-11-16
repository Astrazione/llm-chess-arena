import type { Command, GameEvent, MatchSnapshot } from '../api/contracts';

export interface MatchView { snapshot: MatchSnapshot | null; events: GameEvent[] }
export const emptyView: MatchView = { snapshot: null, events: [] };

export function mergeView(view: MatchView, incoming: MatchSnapshot, events: GameEvent[] = []): MatchView {
  const current = view.snapshot;
  if (incoming.schemaVersion !== 1) return view;
  if (current && (incoming.id !== current.id || incoming.generation < current.generation)) return view;
  const snapshot = !current || incoming.lastEventSequence >= current.lastEventSequence ? incoming : current;
  const unique = new Map<number, GameEvent>();
  for (const event of [...view.events, ...events]) {
    if (event.schemaVersion === 1 && event.matchId === snapshot.id && event.gameId === snapshot.gameId) unique.set(event.sequence, event);
  }
  return { snapshot, events: [...unique.values()].sort((a, b) => a.sequence - b.sequence) };
}

export function allowedCommands(snapshot: MatchSnapshot | null): Record<Command, boolean> {
  const status = snapshot?.status;
  const idle = snapshot !== null && !snapshot.busy;
  return {
    start: status === 'Created' && idle,
    pause: status === 'Running',
    resume: status === 'Paused' && idle,
    'next-move': (status === 'Created' || status === 'Paused') && idle,
    stop: status === 'Created' || status === 'Running' || status === 'Paused',
    reset: snapshot !== null,
  };
}

// Read squares for annotation only. No chess rules or board mutations live here.
export function errorSquares(move: string | null, rawText: string | null): string[] {
  const text = move ?? rawText ?? '';
  const squares = text.match(/[a-h][1-8]/g);
  return squares?.length === 2 ? squares : [];
}
