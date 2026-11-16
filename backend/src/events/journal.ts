import type { GameEvent } from '../contracts/match.js';

export class EventJournal {
  readonly #events: GameEvent[] = [];
  readonly #listeners = new Set<(event: GameEvent) => void>();
  get lastSequence(): number { return this.#events.length; }

  publish(event: Omit<GameEvent, 'sequence' | 'schemaVersion' | 'at'>): void {
    const entry: GameEvent = structuredClone({ ...event, sequence: this.lastSequence + 1, schemaVersion: 1, at: new Date().toISOString() });
    this.#events.push(entry);
    // Observers cannot reenter the game transition or mutate stored events.
    for (const listener of this.#listeners) queueMicrotask(() => {
      if (this.#listeners.has(listener)) {
        try { listener(structuredClone(entry)); } catch { /* An observer cannot break the match. */ }
      }
    });
  }

  read(after = 0, limit = 100) {
    const events = this.#events.slice(after, after + limit);
    return { events: structuredClone(events), lastSequence: this.lastSequence, hasMore: after + events.length < this.lastSequence };
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
