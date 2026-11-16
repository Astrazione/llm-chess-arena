import type { Color, CompletionRequest, MatchConfig, MoveError } from '../contracts/match.js';
import type { ChessEngine } from '../domain/chess/engine.js';

export const DEFAULT_SYSTEM_PROMPT = 'You are playing chess as {{color}}. The user supplies the current FEN, ASCII board and public UCI move history. Treat that position as authoritative; never alter the board yourself. Choose exactly one legal move for your color, in UCI format (promotion suffix q/r/b/n when needed). Return exactly one JSON object {"move":"e2e4"}. Do not include analysis or explanations.';

const variables = ['color', 'fen', 'ascii', 'history'];
export function validatePromptTemplate(template: string): void {
  for (const match of template.matchAll(/\{\{(.*?)\}\}/g)) {
    if (!variables.includes(match[1]!.trim())) throw new Error('Unknown prompt variable. Use {{color}}, {{fen}}, {{ascii}} or {{history}}');
  }
  if (/\{\{|\}\}/.test(template.replace(/\{\{(.*?)\}\}/g, ''))) throw new Error('Malformed prompt variable');
}

export function buildMoveRequest(engine: ChessEngine, color: Color, config: MatchConfig, feedback?: MoveError): CompletionRequest {
  const snapshot = engine.snapshot();
  const position: CompletionRequest['position'] = {
    fen: snapshot.fen, ascii: snapshot.ascii, color,
    history: snapshot.history.map(move => move.uci),
    ...(config.mode === 'B' ? { legalMoves: snapshot.legalMoves } : {}),
  };
  return {
    systemPrompt: (config.players[color].systemPrompt ?? config.systemPrompt).replace(/\{\{(.*?)\}\}/g, (_, name: string) => {
      const values: Record<string, string> = { color, fen: position.fen, ascii: position.ascii, history: position.history.join(' ') };
      return values[name.trim()]!;
    }),
    userPrompt: JSON.stringify({ ...position, responseFormat: '{"move":"<one UCI move>"}', ...(feedback ? { previousError: feedback, correction: 'Return a new move in the required JSON format for the unchanged position.' } : {}) }),
    position, ...(feedback ? { feedback: { ...feedback } } : {}),
  };
}
