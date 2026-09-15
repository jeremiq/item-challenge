/**
 * Local Development Server
 *
 * A simple HTTP server for testing your handlers locally.
 * Run with: pnpm dev
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  createItemHandler,
  getItemHandler,
  updateItemHandler,
  listItemsHandler,
  createVersionHandler,
  getAuditTrailHandler,
  type HandlerResult,
} from './handlers/items.js';

const PORT = process.env.PORT || 3000;

// Route patterns, most specific first so `/api/items/:id/versions` and
// `/api/items/:id/audit` aren't swallowed by the generic `/api/items/:id`
// matchers below them.
const ITEM_VERSIONS_PATH = /^\/api\/items\/([^/]+)\/versions$/;
const ITEM_AUDIT_PATH = /^\/api\/items\/([^/]+)\/audit$/;
const ITEM_PATH = /^\/api\/items\/([^/]+)$/;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

async function routeRequest(req: IncomingMessage): Promise<HandlerResult> {
  const method = req.method ?? 'GET';
  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Normalize trailing slashes (but keep a bare "/" as-is).
  const pathname =
    parsedUrl.pathname.length > 1 ? parsedUrl.pathname.replace(/\/+$/, '') : parsedUrl.pathname;

  console.log(`${method} ${pathname}`);

  let match: RegExpMatchArray | null;

  if (method === 'POST' && pathname === '/api/items') {
    const body = await readJsonBody(req);
    return createItemHandler(body);
  }

  if (method === 'GET' && pathname === '/api/items') {
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    return listItemsHandler(query);
  }

  if (method === 'POST' && (match = pathname.match(ITEM_VERSIONS_PATH))) {
    return createVersionHandler(match[1]);
  }

  if (method === 'GET' && (match = pathname.match(ITEM_AUDIT_PATH))) {
    return getAuditTrailHandler(match[1]);
  }

  if (method === 'GET' && (match = pathname.match(ITEM_PATH))) {
    return getItemHandler(match[1]);
  }

  if (method === 'PUT' && (match = pathname.match(ITEM_PATH))) {
    const body = await readJsonBody(req);
    return updateItemHandler(match[1], body);
  }

  return { statusCode: 404, body: { error: 'Route not found' } };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let result: HandlerResult;

  try {
    result = await routeRequest(req);
  } catch (error) {
    // Malformed JSON bodies etc. land here as a 400, not a 500.
    console.error('Request error:', error);
    result = {
      statusCode: 400,
      body: { error: error instanceof Error ? error.message : 'Invalid request' },
    };
  }

  res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('Unhandled server error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST   http://localhost:${PORT}/api/items`);
  console.log(`  GET    http://localhost:${PORT}/api/items`);
  console.log(`  GET    http://localhost:${PORT}/api/items/:id`);
  console.log(`  PUT    http://localhost:${PORT}/api/items/:id`);
  console.log(`  POST   http://localhost:${PORT}/api/items/:id/versions`);
  console.log(`  GET    http://localhost:${PORT}/api/items/:id/audit`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
