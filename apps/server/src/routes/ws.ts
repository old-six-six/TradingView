import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { bus, lastSnapshot, setDetail } from '../service/poller.js';

const clients = new Set<WebSocket>();

export function setupWs(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, { type: 'snapshot', data: lastSnapshot(), ts: Date.now() });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'subscribe' && typeof msg.symbol === 'string') {
          setDetail(msg.symbol);
        }
      } catch {
        /* 忽略非法消息 */
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  bus.on('quotes', (payload: { quotes: unknown[]; stale: boolean; ts: number }) => {
    broadcast({ type: 'quote', data: payload.quotes, stale: payload.stale, ts: payload.ts });
  });

  broadcast({ type: 'hello', data: { ok: true }, ts: Date.now() });
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function broadcast(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

export function clientCount(): number {
  return clients.size;
}
