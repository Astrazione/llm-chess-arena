import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from '../test/match-fixture';
import { useMatch } from './use-match';

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (message: { data: string }) => void>();
  close = vi.fn();
  constructor() { TestEventSource.instances.push(this); }
  addEventListener(type: string, listener: (message: { data: string }) => void) { this.listeners.set(type, listener); }
  send(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); TestEventSource.instances = []; });
describe('SSE recovery', () => {
  it('diagnoses a lost RAM match even when a reconnect returns 404 before onopen', async () => {
    vi.stubGlobal('EventSource', TestEventSource);
    let lost = false;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(lost
      ? new Response(JSON.stringify({ error: { message: 'Match not found' } }), { status: 404 })
      : new Response(JSON.stringify(snapshot)))));
    const { result } = renderHook(useMatch);
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    lost = true;
    act(() => TestEventSource.instances[0]!.onerror?.());
    await waitFor(() => expect(result.current.error).toContain('Backend перезапущен'));
    expect(result.current.snapshot?.gameId).toBe(snapshot.gameId);
    expect(result.current.connection).toBe('Восстановление соединения');
  });
  it('refreshes REST on reconnect, deduplicates replay and closes on unmount', async () => {
    vi.stubGlobal('EventSource', TestEventSource);
    const event = { schemaVersion: 1, matchId: 'match', gameId: 'game-1', sequence: 1, at: '', type: 'GameCreated', data: {} };
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/events') ? { events: [event], hasMore: false } : snapshot))));
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(useMatch);
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    const stream = TestEventSource.instances[0]!;
    act(() => stream.onopen?.());
    await waitFor(() => expect(result.current.connection).toBe('SSE подключён'));
    const calls = fetchMock.mock.calls.length;
    act(() => { stream.onerror?.(); stream.send('match', { schemaVersion: 1, event, snapshot }); });
    expect(result.current.connection).toBe('Восстановление соединения');
    act(() => stream.onopen?.());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current.connection).toBe('SSE подключён'));
    expect(result.current.events).toHaveLength(1);
    unmount();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
