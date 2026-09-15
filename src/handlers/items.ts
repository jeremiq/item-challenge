/**
 * Handlers for the exam item management API.
 *
 * Each takes already-parsed input and returns `{ statusCode, body }`, leaving
 * transport concerns to the caller: src/server.ts locally, and the adapters in
 * infrastructure/lambda-adapters on AWS.
 */

import { z } from 'zod';
import { createStorage } from '../storage/index.js';
import { ConflictError } from '../storage/errors.js';

// Module scope, so Lambda reuses one storage client across warm invocations.
const storage = createStorage();

export interface HandlerResult {
  statusCode: number;
  body: unknown;
}

const itemTypeSchema = z.enum(['multiple-choice', 'free-response', 'essay']);
const securityLevelSchema = z.enum(['standard', 'secure', 'highly-secure']);
const statusSchema = z.enum(['draft', 'review', 'approved', 'archived']);

// Upper bounds on free text. DynamoDB caps an item at 400KB, and every edit
// copies the whole item into a new version row, so unbounded fields are a
// storage problem as well as a request-size one. These caps put a worst-case
// item near 55KB — roomy for real exam content, far below the hard limit.
const LIMITS = {
  subject: 200,
  question: 10_000,
  explanation: 10_000,
  answer: 5_000,
  optionCount: 26, // A-Z
  author: 200,
  tag: 50,
  tagCount: 25,
} as const;

const contentSchema = z.object({
  question: z.string().min(1, 'question is required').max(LIMITS.question),
  options: z.array(z.string().max(LIMITS.answer)).max(LIMITS.optionCount).optional(),
  correctAnswer: z.string().min(1, 'correctAnswer is required').max(LIMITS.answer),
  explanation: z.string().min(1, 'explanation is required').max(LIMITS.explanation),
});

const metadataSchema = z.object({
  author: z.string().min(1, 'author is required').max(LIMITS.author),
  status: statusSchema,
  tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tagCount),
});

const createItemSchema = z.object({
  subject: z.string().min(1, 'subject is required').max(LIMITS.subject),
  itemType: itemTypeSchema,
  difficulty: z.number().int('difficulty must be an integer').min(1).max(5),
  content: contentSchema,
  metadata: metadataSchema,
  securityLevel: securityLevelSchema,
});

// Derived from the create schema so a new field can't be silently un-updatable.
// content/metadata are made partial too, so a caller can patch one nested field
// without resending the rest. Neither exposes created/lastModified/version:
// those are server-managed.
const updateItemSchema = createItemSchema
  .partial()
  .extend({
    content: contentSchema.partial().optional(),
    metadata: metadataSchema.partial().optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const listItemsQuerySchema = z.object({
  limit: z.coerce.number().int('limit must be an integer').min(1).max(100).optional().default(10),
  offset: z.coerce.number().int('offset must be an integer').min(0).optional().default(0),
  subject: z.string().min(1).max(LIMITS.subject).optional(),
  status: statusSchema.optional(),
});

// Return types are left to inference so each handler's result stays a union
// discriminated on the literal statusCode, which callers can narrow.
function validationError(error: z.ZodError) {
  return {
    statusCode: 400 as const,
    body: {
      error: 'Validation failed',
      details: error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  };
}

function conflict() {
  return {
    statusCode: 409 as const,
    body: { error: 'Item was modified concurrently, retry with the latest version' },
  };
}

function internalError(context: string, error: unknown) {
  console.error(`Error ${context}:`, error);
  return {
    statusCode: 500 as const,
    body: { error: 'Internal server error' },
  };
}

/** A lost write race is the client's to retry (409), not a server fault (500). */
function writeError(context: string, error: unknown) {
  return error instanceof ConflictError ? conflict() : internalError(context, error);
}

function notFound() {
  return {
    statusCode: 404 as const,
    body: { error: 'Item not found' },
  };
}

/** POST /api/items */
export async function createItemHandler(data: unknown) {
  try {
    const parsed = createItemSchema.safeParse(data);
    if (!parsed.success) return validationError(parsed.error);

    const item = await storage.createItem(parsed.data);

    return {
      statusCode: 201 as const,
      body: item,
    };
  } catch (error) {
    return writeError('creating item', error);
  }
}

/** GET /api/items/:id */
export async function getItemHandler(id: string) {
  try {
    const item = await storage.getItem(id);

    if (!item) {
      return notFound();
    }

    return { statusCode: 200 as const, body: item };
  } catch (error) {
    return internalError('getting item', error);
  }
}

/** PUT /api/items/:id */
export async function updateItemHandler(id: string, data: unknown) {
  try {
    const parsed = updateItemSchema.safeParse(data);
    if (!parsed.success) return validationError(parsed.error);

    const item = await storage.updateItem(id, parsed.data);

    if (!item) {
      return notFound();
    }

    return { statusCode: 200 as const, body: item };
  } catch (error) {
    return writeError('updating item', error);
  }
}

/** GET /api/items */
export async function listItemsHandler(query: unknown) {
  try {
    const parsed = listItemsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) return validationError(parsed.error);

    const { limit, offset, subject, status } = parsed.data;
    const { items, total } = await storage.listItems({ limit, offset, subject, status });

    return {
      statusCode: 200 as const,
      body: { items, total, limit, offset },
    };
  } catch (error) {
    return internalError('listing items', error);
  }
}

/** POST /api/items/:id/versions */
export async function createVersionHandler(id: string) {
  try {
    const item = await storage.createVersion(id);

    if (!item) {
      return notFound();
    }

    return { statusCode: 201 as const, body: item };
  } catch (error) {
    return writeError('creating version', error);
  }
}

/**
 * GET /api/items/:id/audit
 *
 * The getItem read only distinguishes "no such item" (404) from "item with no
 * history yet" (200 and an empty array), so it runs alongside the history read
 * rather than before it.
 */
export async function getAuditTrailHandler(id: string) {
  try {
    const [item, history] = await Promise.all([storage.getItem(id), storage.getAuditTrail(id)]);

    if (!item) {
      return notFound();
    }

    return { statusCode: 200 as const, body: history };
  } catch (error) {
    return internalError('getting audit trail', error);
  }
}
