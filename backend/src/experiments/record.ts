import type { Experiment, GameEvent, MatchSnapshot, PlayerSettings } from '../contracts/match.js';
import { ChessEngine } from '../domain/chess/engine.js';
import { statistics } from './statistics.js';

export const playerName = (settings: PlayerSettings): string => settings.provider === 'openai-compatible' ? settings.modelId : `Mock/${settings.strategy}`;

export function exportPgn(record: Experiment): string {
  const { snapshot } = record;
  const engine = new ChessEngine(snapshot.position.positions[0]);
  for (const move of snapshot.position.history) engine.applyMove(move.uci);
  return engine.exportPgn(snapshot.result?.score, {
    Event: 'LLM Chess Arena', Site: 'Local', Date: record.createdAt.slice(0, 10).replaceAll('-', '.'), Round: '-',
    White: playerName(snapshot.config.players.white), Black: playerName(snapshot.config.players.black),
    GameId: record.id, MatchId: record.matchId, Mode: snapshot.config.mode,
    Termination: !snapshot.result || snapshot.result.kind === 'Limit' ? 'unterminated' : snapshot.result.kind === 'TechnicalLoss' ? 'rules infraction' : snapshot.result.kind === 'Stopped' ? 'abandoned' : 'normal',
    ResultKind: snapshot.result?.kind ?? 'Ongoing', EndReason: snapshot.result?.reason ?? 'Ongoing',
  });
}

export function experiment(snapshot: MatchSnapshot, allEvents: GameEvent[]): Experiment {
  const events = allEvents.filter(event => event.gameId === snapshot.gameId);
  return {
    schema: 'llm-chess-arena/experiment', schemaVersion: 1, id: snapshot.gameId, matchId: snapshot.id,
    createdAt: events[0]?.at ?? new Date().toISOString(), updatedAt: events.at(-1)?.at ?? new Date().toISOString(),
    snapshot, events, statistics: snapshot.statistics ?? statistics(snapshot, events),
  };
}
