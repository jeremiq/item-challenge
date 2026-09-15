/**
 * Handler tests: happy path plus a key error case for each of the 6 endpoints,
 * against the default in-memory storage.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createItemHandler,
  createVersionHandler,
  getAuditTrailHandler,
  getItemHandler,
  listItemsHandler,
  updateItemHandler,
} from '../handlers/items.js';
import type { CreateItemRequest } from '../types/item.js';
import { expectStatus, validItemData } from './helpers.js';

async function createTestItem(overrides: Partial<CreateItemRequest> = {}) {
  const result = await createItemHandler(validItemData(overrides));
  expectStatus(result, 201);
  return result.body;
}

describe('createItemHandler', () => {
  it('creates an item at version 1', async () => {
    const result = await createItemHandler(validItemData());

    expectStatus(result, 201);
    expect(result.body.id).toEqual(expect.any(String));
    expect(result.body.subject).toBe('AP Biology');
    expect(result.body.metadata).toMatchObject({ author: 'test-author', version: 1 });
  });

  it('returns 400 with per-field details for invalid input', async () => {
    const result = await createItemHandler({
      ...validItemData(),
      itemType: 'not-a-real-type',
      difficulty: 10,
    });

    expectStatus(result, 400);
    expect(result.body.error).toBe('Validation failed');
    expect(result.body.details.map(d => d.path)).toEqual(['itemType', 'difficulty']);
  });

  it('rejects free text beyond the field caps', async () => {
    const item = validItemData();
    const result = await createItemHandler({
      ...item,
      subject: 'x'.repeat(201),
      content: { ...item.content, question: 'q'.repeat(10_001) },
    });

    expectStatus(result, 400);
    expect(result.body.details.map(d => d.path)).toEqual(['subject', 'content.question']);
  });
});

describe('getItemHandler', () => {
  it('retrieves an existing item', async () => {
    const created = await createTestItem({ subject: 'AP Calculus', itemType: 'free-response' });

    const result = await getItemHandler(created.id);

    expectStatus(result, 200);
    expect(result.body.id).toBe(created.id);
    expect(result.body.subject).toBe('AP Calculus');
  });

  it('returns 404 for a non-existent item', async () => {
    const result = await getItemHandler('non-existent-id');

    expectStatus(result, 404);
    expect(result.body.error).toBe('Item not found');
  });
});

describe('updateItemHandler', () => {
  it('merges the update, preserving untouched fields and bumping the version', async () => {
    const created = await createTestItem();

    const result = await updateItemHandler(created.id, {
      difficulty: 5,
      metadata: { status: 'approved' },
    });

    expectStatus(result, 200);
    expect(result.body.difficulty).toBe(5);
    expect(result.body.metadata).toMatchObject({
      status: 'approved',
      author: 'test-author',
      tags: ['biology', 'photosynthesis'],
      version: 2,
    });
  });

  it('returns 404 when updating a non-existent item', async () => {
    const result = await updateItemHandler('non-existent-id', { difficulty: 2 });

    expectStatus(result, 404);
    expect(result.body.error).toBe('Item not found');
  });

  it('returns 400 for an out-of-range value', async () => {
    const created = await createTestItem();

    const result = await updateItemHandler(created.id, { difficulty: 99 });

    expectStatus(result, 400);
    expect(result.body.error).toBe('Validation failed');
  });
});

describe('listItemsHandler', () => {
  it('lists matching items with pagination defaults applied', async () => {
    await createTestItem({ subject: 'List Test Subject A' });
    await createTestItem({ subject: 'List Test Subject A' });

    const result = await listItemsHandler({ subject: 'List Test Subject A' });

    expectStatus(result, 200);
    expect(result.body.items).toHaveLength(2);
    expect(result.body).toMatchObject({ total: 2, limit: 10, offset: 0 });
  });

  // Timestamps are driven explicitly: Date.now() has millisecond resolution, so
  // back-to-back writes tie and fall through to the (arbitrary) id tie-break.
  it('returns matching items newest-first', async () => {
    vi.useFakeTimers();
    try {
      const subject = 'Ordering Test Subject';

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = await createTestItem({ subject });

      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const second = await createTestItem({ subject });

      // Reverse of insertion order, so this fails if nothing sorts.
      const byRecency = await listItemsHandler({ subject });
      expectStatus(byRecency, 200);
      expect(byRecency.body.items.map(item => item.id)).toEqual([second.id, first.id]);

      // Touching the older item moves it to the front: lastModified drives the
      // order, not creation time.
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      await updateItemHandler(first.id, { difficulty: 4 });

      const afterTouch = await listItemsHandler({ subject });
      expectStatus(afterTouch, 200);
      expect(afterTouch.body.items.map(item => item.id)).toEqual([first.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a limit above the maximum rather than clamping it', async () => {
    const result = await listItemsHandler({ limit: '500' });

    expectStatus(result, 400);
    expect(result.body.error).toBe('Validation failed');
  });
});

describe('createVersionHandler', () => {
  it('snapshots the current item as a new version', async () => {
    const created = await createTestItem();

    const result = await createVersionHandler(created.id);

    expectStatus(result, 201);
    expect(result.body.metadata.version).toBe(2);
  });

  it('returns 404 for a non-existent item', async () => {
    const result = await createVersionHandler('non-existent-id');

    expectStatus(result, 404);
    expect(result.body.error).toBe('Item not found');
  });
});

describe('getAuditTrailHandler', () => {
  it('returns every version in order, including the item as created', async () => {
    const created = await createTestItem();
    await createVersionHandler(created.id);

    const result = await getAuditTrailHandler(created.id);

    expectStatus(result, 200);
    expect(result.body.map(version => version.metadata.version)).toEqual([1, 2]);
  });

  it('returns 404 for a non-existent item', async () => {
    const result = await getAuditTrailHandler('non-existent-id');

    expectStatus(result, 404);
    expect(result.body.error).toBe('Item not found');
  });
});
