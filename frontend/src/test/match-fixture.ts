import type { MatchSnapshot } from '../api/contracts';

export const snapshot: MatchSnapshot = {
  schemaVersion: 1, id: 'match', gameId: 'game-1', generation: 1, status: 'Created', busy: false,
  config: { players: { white: { strategy: 'RandomLegalMove' }, black: { strategy: 'RandomLegalMove' } }, mode: 'A', maxPlies: 12, maxRetries: 2, moveDelayMs: 600, systemPrompt: 'Move' },
  position: { fen: '8/8/8/8/8/8/8/8 w - - 0 1', turn: 'white', inCheck: false, history: [], positions: ['initial'], claimableDraws: [] },
  attempts: [], result: null, pgn: '', lastEventSequence: 1,
};
