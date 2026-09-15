/**
 * DynamoDB Storage Implementation
 *
 * Single-table design. See ARCHITECTURE.md for the rationale behind this
 * schema and its trade-offs; the layout itself is:
 *
 *   PK = `ITEM#<id>`  SK = `METADATA`                    -> current record
 *   PK = `ITEM#<id>`  SK = `VERSION#<version, 0-padded>` -> immutable snapshot
 *
 *   GSI1  GSI1PK = `SUBJECT#<subject>`
 *         GSI1SK = `<lastModified ISO>#<id>`
 *   GSI2  GSI2PK = `STATUS#<status>`
 *         GSI2SK = `<lastModified ISO>#<id>`
 *
 * Version numbers are zero-padded so lexicographic SK order is chronological
 * order. Both GSIs are sparse — their keys are written only on METADATA
 * records — so history never appears in list results. Both sort on
 * lastModified alone, so every filtered list is newest-first; putting status
 * ahead of it in GSI1SK would instead group a subject's items by status and
 * hide drafts behind a page of approved items.
 *
 * Local development:
 * 1. USE_DYNAMODB=true
 * 2. Configure AWS credentials, or run DynamoDB Local and set
 *    DYNAMODB_ENDPOINT=http://localhost:8000
 * 3. DYNAMODB_TABLE_NAME (defaults to "ExamItems")
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ExamItem, CreateItemRequest, UpdateItemRequest, ListItemsQuery } from '../types/item.js';
import { ItemStorage } from './interface.js';
import { ConflictError } from './errors.js';

/** Internal representation of a row stored in the single table. */
interface ItemRecord extends ExamItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
}

const CURRENT_SK = 'METADATA';
const VERSION_SK_PREFIX = 'VERSION#';
/** Upper bound on rows fetched per Query/Scan round trip. */
const PAGE_SIZE = 50;

function itemPK(id: string): string {
  return `ITEM#${id}`;
}

function versionSK(version: number): string {
  return `${VERSION_SK_PREFIX}${String(version).padStart(6, '0')}`;
}

/**
 * A cancelled transaction means one of our `attribute_not_exists` guards lost
 * a race; any other cancellation reason (throttling, size limits) is a real
 * failure and must not be reported to the client as a conflict.
 */
function isConditionalCheckFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false;

  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some(reason => reason?.Code === 'ConditionalCheckFailed');
}

/** Strips DynamoDB-only bookkeeping attributes back down to the public ExamItem shape. */
function toExamItem(record: ItemRecord): ExamItem {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...rest } = record;
  return rest;
}

function buildCurrentRecord(item: ExamItem): ItemRecord {
  const lastModifiedIso = new Date(item.metadata.lastModified).toISOString();
  return {
    ...item,
    PK: itemPK(item.id),
    SK: CURRENT_SK,
    GSI1PK: `SUBJECT#${item.subject}`,
    GSI1SK: `${lastModifiedIso}#${item.id}`,
    GSI2PK: `STATUS#${item.metadata.status}`,
    GSI2SK: `${lastModifiedIso}#${item.id}`,
  };
}

/** No GSI keys: history rows stay out of the (sparse) list indexes. */
function buildVersionRecord(item: ExamItem): ItemRecord {
  return {
    ...item,
    PK: itemPK(item.id),
    SK: versionSK(item.metadata.version),
  };
}

type PageResult = { items: ItemRecord[]; lastKey?: Record<string, unknown> };
type CountResult = { count: number; lastKey?: Record<string, unknown> };

/**
 * Picks the access path for a list query. Filtered lists Query an index
 * newest-first; an unfiltered list has no single partition to query, so it
 * Scans instead — but it scans GSI1, not the base table. GSI1 is sparse and
 * projects everything, so it holds exactly one row per current item: scanning
 * it skips every version row, where a base-table scan would read them all and
 * discard them after the fact. Scan order is unspecified, so the newest-first
 * guarantee applies only to the filtered paths.
 */
function buildListAccess(query: ListItemsQuery): {
  command: 'query' | 'scan';
  params: Record<string, unknown>;
} {
  if (query.subject) {
    const values: Record<string, unknown> = { ':pk': `SUBJECT#${query.subject}` };
    // Filter on GSI2PK rather than metadata.status: it already carries the
    // status, is top-level, and avoids quoting `status` (a reserved word).
    if (query.status) values[':statusPk'] = `STATUS#${query.status}`;

    return {
      command: 'query',
      params: {
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ...(query.status && { FilterExpression: 'GSI2PK = :statusPk' }),
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
      },
    };
  }

  if (query.status) {
    return {
      command: 'query',
      params: {
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `STATUS#${query.status}` },
        ScanIndexForward: false,
      },
    };
  }

  return { command: 'scan', params: { IndexName: 'GSI1' } };
}

export class DynamoDBStorage implements ItemStorage {
  private client: DynamoDBDocumentClient;
  private tableName: string;

  constructor() {
    const dynamoClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
    });

    this.client = DynamoDBDocumentClient.from(dynamoClient);
    this.tableName = process.env.DYNAMODB_TABLE_NAME || 'ExamItems';
  }

  async createItem(data: CreateItemRequest): Promise<ExamItem> {
    const now = Date.now();
    const item: ExamItem = {
      id: randomUUID(),
      ...data,
      metadata: {
        ...data.metadata,
        created: now,
        lastModified: now,
        version: 1,
      },
    };

    // requireNew also guards against an id collision overwriting an existing item.
    await this.putWithSnapshot(item, { requireNew: true });

    return item;
  }

  async getItem(id: string): Promise<ExamItem | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: itemPK(id), SK: CURRENT_SK },
      })
    );

    return result.Item ? toExamItem(result.Item as ItemRecord) : null;
  }

  async updateItem(id: string, data: UpdateItemRequest): Promise<ExamItem | null> {
    const existing = await this.getItem(id);
    if (!existing) return null;

    const updated: ExamItem = {
      ...existing,
      ...data,
      content: data.content ? { ...existing.content, ...data.content } : existing.content,
      metadata: {
        ...existing.metadata,
        ...(data.metadata || {}),
        lastModified: Date.now(),
        version: existing.metadata.version + 1,
      },
    };

    await this.putWithSnapshot(updated);

    return updated;
  }

  async listItems(query: ListItemsQuery): Promise<{ items: ExamItem[]; total: number }> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;
    const access = buildListAccess(query);

    const send = (extra: Record<string, unknown>) => {
      const input = { TableName: this.tableName, ...access.params, ...extra };
      return this.client.send(
        access.command === 'query' ? new QueryCommand(input) : new ScanCommand(input)
      );
    };

    const [records, total] = await Promise.all([
      this.paginateWithOffset(offset, limit, async (startKey) => {
        const result = await send({
          // Never fetch beyond the page being returned.
          Limit: Math.min(PAGE_SIZE, offset + limit),
          ExclusiveStartKey: startKey,
        });
        return { items: (result.Items ?? []) as ItemRecord[], lastKey: result.LastEvaluatedKey };
      }),
      this.countAll(async (startKey) => {
        // No Limit here: COUNT pages natively at 1MB, so capping it to
        // PAGE_SIZE rows would only multiply the round trips.
        const result = await send({ Select: 'COUNT', ExclusiveStartKey: startKey });
        return { count: result.Count ?? 0, lastKey: result.LastEvaluatedKey };
      }),
    ]);

    return { items: records.map(toExamItem), total };
  }

  async createVersion(id: string): Promise<ExamItem | null> {
    const existing = await this.getItem(id);
    if (!existing) return null;

    // Snapshots the current state under a new version, changing no fields.
    const updated: ExamItem = {
      ...existing,
      metadata: {
        ...existing.metadata,
        version: existing.metadata.version + 1,
        lastModified: Date.now(),
      },
    };

    await this.putWithSnapshot(updated);

    return updated;
  }

  async getAuditTrail(id: string): Promise<ExamItem[]> {
    const records: ItemRecord[] = [];
    let startKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': itemPK(id), ':prefix': VERSION_SK_PREFIX },
          ScanIndexForward: true, // ascending SK == chronological
          ExclusiveStartKey: startKey,
        })
      );
      records.push(...((result.Items ?? []) as ItemRecord[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey);

    return records.map(toExamItem);
  }

  /**
   * Writes an item's current record and appends its version snapshot in one
   * transaction, so the two can never diverge. The snapshot is always
   * condition-guarded: history is append-only and must never be overwritten.
   */
  private async putWithSnapshot(item: ExamItem, options: { requireNew?: boolean } = {}) {
    const unlessExists = 'attribute_not_exists(PK)';

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: buildCurrentRecord(item),
                ...(options.requireNew && { ConditionExpression: unlessExists }),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: buildVersionRecord(item),
                ConditionExpression: unlessExists,
              },
            },
          ],
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw new ConflictError();
      throw error;
    }
  }

  /**
   * Emulates offset/limit pagination on top of DynamoDB's forward-only cursor
   * pagination by walking pages from the start, discarding the first `offset`
   * matches, and collecting the next `limit`. O(offset) per call — see
   * ARCHITECTURE.md for why the interface keeps a numeric offset anyway.
   */
  private async paginateWithOffset(
    offset: number,
    limit: number,
    fetchPage: (startKey?: Record<string, unknown>) => Promise<PageResult>
  ): Promise<ItemRecord[]> {
    const collected: ItemRecord[] = [];
    let skipped = 0;
    let startKey: Record<string, unknown> | undefined;

    while (collected.length < limit) {
      const page = await fetchPage(startKey);

      for (const record of page.items) {
        if (skipped < offset) {
          skipped++;
        } else {
          collected.push(record);
          if (collected.length >= limit) break;
        }
      }

      if (!page.lastKey) break;
      startKey = page.lastKey;
    }

    return collected;
  }

  /** Sums Select:COUNT across every page of a Query/Scan to get an exact total. */
  private async countAll(
    countPage: (startKey?: Record<string, unknown>) => Promise<CountResult>
  ): Promise<number> {
    let total = 0;
    let startKey: Record<string, unknown> | undefined;

    do {
      const page = await countPage(startKey);
      total += page.count;
      startKey = page.lastKey;
    } while (startKey);

    return total;
  }
}
