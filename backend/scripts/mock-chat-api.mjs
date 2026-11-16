// Test-only OpenAI-compatible HTTP server. Never part of the default Compose stack.
import { createServer } from 'node:http';
import { Chess } from 'chess.js';

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') { response.end('ok'); return; }
  if (request.method === 'GET' && /^\/(white|black)\/v1\/models$/.test(request.url ?? '')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'legal', max_model_len: 4096 }] })); return;
  }
  if (request.method !== 'POST' || !/^\/(white|black)\/v1\/chat\/completions$/.test(request.url ?? '')) {
    response.writeHead(404); response.end(); return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model === 'oom') {
      response.writeHead(500); response.end(JSON.stringify({ error: { message: 'CUDA out of memory: PRIVATE runtime data' } })); return;
    }
    if (body.model === 'rate-limit' || body.model === 'reject-parameters') {
      response.writeHead(body.model === 'rate-limit' ? 429 : 400);
      response.end('{"error":{"message":"Test API rejection"}}'); return;
    }
    const user = body.messages.find(message => message.role === 'user').content;
    const probe = user.startsWith('Connection check');
    if (body.model === 'delay' && !probe) await new Promise(resolve => setTimeout(resolve, 1500));
    let content = '{"move":"e2e4"}';
    if (!probe) {
      const position = JSON.parse(user);
      const chess = new Chess(position.fen);
      const next = chess.moves({ verbose: true })[0];
      content = JSON.stringify({ move: `${next.from}${next.to}${next.promotion ?? ''}` });
      if (body.model === 'malformed') content = '{"move":';
      if (body.model === 'illegal') content = '{"move":"a1a1"}';
      if (body.model === 'correct-on-retry' && !position.previousError) content = '{"move":"a1a1"}';
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } }));
  } catch {
    response.writeHead(400); response.end();
  }
});
server.listen(8080, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(); });
