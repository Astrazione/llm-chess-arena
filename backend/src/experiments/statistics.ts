import type { Color, ExperimentStatistics, GameEvent, MatchSnapshot } from '../contracts/match.js';

export function statistics(snapshot: MatchSnapshot, events: GameEvent[]): ExperimentStatistics {
  const player = (color: Color) => {
    const attempts = snapshot.attempts.filter(attempt => attempt.color === color);
    const completed = attempts.filter(attempt => attempt.status === 'Accepted' || attempt.status === 'Rejected');
    const times = attempts.flatMap(attempt => attempt.metrics?.responseTimeMs == null ? [] : [attempt.metrics.responseTimeMs]).sort((a, b) => a - b);
    const sumTokens = (key: 'inputTokens' | 'outputTokens') => {
      const samples = attempts.flatMap(attempt => attempt.metrics?.[key] == null ? [] : [attempt.metrics[key]!]);
      return { value: samples.length ? samples.reduce((a, b) => a + b, 0) : null, count: samples.length };
    };
    const input = sumTokens('inputTokens'), output = sumTokens('outputTokens');
    const successful = attempts.filter(attempt => attempt.status === 'Accepted').length;
    return {
      successfulMoves: successful, illegalMoves: attempts.filter(attempt => attempt.error?.code === 'IllegalMove').length,
      formatErrors: attempts.filter(attempt => attempt.error?.code === 'InvalidFormat' || attempt.error?.code === 'EmptyResponse').length,
      errors: attempts.filter(attempt => attempt.error).length, retries: attempts.filter(attempt => attempt.attemptNumber > 1).length,
      requests: attempts.length, completedAttempts: completed.length, legalMoveRatio: completed.length ? successful / completed.length : null,
      meanResponseMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      medianResponseMs: times.length ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2 : null,
      inputTokens: input.value, outputTokens: output.value, inputTokenSamples: input.count, outputTokenSamples: output.count, responseSamples: times.length,
    };
  };
  const gameEvents = events.filter(event => event.gameId === snapshot.gameId);
  const start = gameEvents.find(event => event.type === 'GameStarted')?.at;
  const end = gameEvents.findLast(event => event.type === 'GameCompleted' || event.type === 'GameStopped')?.at;
  const result = snapshot.result;
  const preflightRequests = snapshot.providerChecks.filter(check => snapshot.config.players[check.color].provider === 'openai-compatible').length;
  return {
    players: { white: player('white'), black: player('black') }, plies: snapshot.position.history.length,
    durationMs: start ? Math.max(0, Date.parse(end ?? new Date().toISOString()) - Date.parse(start)) : null,
    moveRequests: snapshot.attempts.length, preflightRequests, totalRequests: snapshot.attempts.length + preflightRequests,
    resultCategory: !result ? 'Ongoing' : result.kind === 'Chess' ? (result.winner ? 'ChessWin' : 'Draw')
      : result.kind === 'ClaimedDraw' ? 'Draw' : result.kind,
  };
}
