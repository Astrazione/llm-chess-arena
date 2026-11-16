import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../api/contracts';
import { snapshot } from '../test/match-fixture';
import { allowedCommands, emptyView, errorSquares, mergeView } from './match-state';

const event = (sequence: number, gameId = 'game-1'): GameEvent => ({
  schemaVersion: 1, matchId: 'match', gameId, sequence, at: '', type: 'GameCreated', status: 'Created', ply: 0, fen: '', data: {},
});
describe('authoritative view', () => {
  it('deduplicates SSE and REST events, orders the journal and ignores older snapshots', () => {
    const current = { ...snapshot, lastEventSequence: 5, status: 'Paused' as const };
    let view = mergeView(emptyView, current, [event(5), event(3)]);
    view = mergeView(view, snapshot, [event(3), event(2)]);
    expect(view.snapshot).toBe(current);
    expect(view.events.map(item => item.sequence)).toEqual([2, 3, 5]);
  });
  it('clears old-game logs after Reset and rejects late replies and events', () => {
    let view = mergeView(emptyView, snapshot, [event(1)]);
    const reset = { ...snapshot, gameId: 'game-2', generation: 2, lastEventSequence: 8 };
    view = mergeView(view, reset, [event(8, 'game-2'), event(6)]);
    view = mergeView(view, snapshot, [event(7)]);
    expect(view.snapshot).toBe(reset);
    expect(view.events.map(item => item.sequence)).toEqual([8]);
  });
  it('disables overlapping moves while leaving Stop and Reset available', () => {
    expect(allowedCommands({ ...snapshot, status: 'Paused', busy: true })).toEqual({ start: false, pause: false, resume: false, 'next-move': false, stop: true, reset: true });
    expect(allowedCommands({ ...snapshot, status: 'Completed' }).start).toBe(false);
    expect(allowedCommands({ ...snapshot, status: 'Running' }).pause).toBe(true);
    expect(allowedCommands(snapshot)['next-move']).toBe(true);
  });
  it('annotates only two recognizable squares without applying moves', () => {
    expect(errorSquares('e2e5', null)).toEqual(['e2', 'e5']);
    expect(errorSquares(null, '{"move":"a1a1"}')).toEqual(['a1', 'a1']);
    expect(errorSquares(null, '{"move":')).toEqual([]);
    expect(errorSquares(null, 'a1 b2 c3')).toEqual([]);
  });
});
