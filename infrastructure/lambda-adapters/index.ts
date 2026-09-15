/**
 * Translates between API Gateway's proxy event/response and the plain handler
 * signatures in src/handlers/items.ts, so the same handlers back both this and
 * the local dev server.
 *
 * All six functions deploy from this one file; the stack picks each via
 * NodejsFunction's `handler` prop (e.g. `handler: 'createItem'`).
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  createItemHandler,
  createVersionHandler,
  getAuditTrailHandler,
  getItemHandler,
  listItemsHandler,
  updateItemHandler,
  type HandlerResult,
} from '../../src/handlers/items';

/** Thrown for input API Gateway accepted but the handler can't be given. */
class BadRequestError extends Error {}

function toApiResponse(result: HandlerResult): APIGatewayProxyResult {
  return {
    statusCode: result.statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result.body),
  };
}

function parseBody(body: string | null): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequestError('Request body must be valid JSON');
  }
}

async function adapt(run: () => Promise<HandlerResult>): Promise<APIGatewayProxyResult> {
  try {
    return toApiResponse(await run());
  } catch (error) {
    if (error instanceof BadRequestError) {
      return toApiResponse({ statusCode: 400, body: { error: error.message } });
    }
    console.error('Unhandled error in Lambda adapter:', error);
    return toApiResponse({ statusCode: 500, body: { error: 'Internal server error' } });
  }
}

// API Gateway can't route `/api/items/{id}` without an id, so it's always set.
const itemId = (event: APIGatewayProxyEvent): string => event.pathParameters!.id!;

// Query values arrive as strings; listItemsHandler's schema coerces them.
export const listItems = (event: APIGatewayProxyEvent) =>
  adapt(() => listItemsHandler(event.queryStringParameters ?? {}));

export const createItem = (event: APIGatewayProxyEvent) =>
  adapt(() => createItemHandler(parseBody(event.body)));

export const getItem = (event: APIGatewayProxyEvent) => adapt(() => getItemHandler(itemId(event)));

export const updateItem = (event: APIGatewayProxyEvent) =>
  adapt(() => updateItemHandler(itemId(event), parseBody(event.body)));

export const createVersion = (event: APIGatewayProxyEvent) =>
  adapt(() => createVersionHandler(itemId(event)));

export const getAuditTrail = (event: APIGatewayProxyEvent) =>
  adapt(() => getAuditTrailHandler(itemId(event)));
