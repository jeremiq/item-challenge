/**
 * DynamoDB storage tests.
 *
 * The Document Client is mocked (aws-sdk-client-mock), so these verify the
 * commands we build — key construction, index selection, condition
 * expressions and the offset-pagination walk — without a real table.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { validItemData } from './helpers.js';
import { ConflictError } from '../storage/errors.js';

process.env.DYNAMODB_TABLE_NAME = 'TestExamItems';

const ddbMock = mockClient(DynamoDBDocumentClient);

// Imported after the env var is set, so the storage picks up the test table.
const { DynamoDBStorage } = await import('../storage/dynamodb.js');

/** Mimics the shape the SDK throws when a TransactWriteItems is cancelled. */
function cancelledTransaction(reasonCode: string) {
  const error = new Error('Transaction cancelled, please refer to CancellationReasons');
  error.name = 'TransactionCanceledException';
  Object.assign(error, { CancellationReasons: [{ Code: reasonCode }, { Code: 'None' }] });
  return error;
}

/** A stored CURRENT row, as the mocked client would return it. */
function storedRecord({ id, version = 1 }: { id: string; version?: number }) {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  return {
    ...validItemData(),
    id,
    metadata: { ...validItemData().metadata, created: now, lastModified: now, version },
    PK: `ITEM#${id}`,
    SK: 'METADATA',
    GSI1PK: 'SUBJECT#AP Biology',
    GSI1SK: `${iso}#${id}`,
    GSI2PK: 'STATUS#draft',
    GSI2SK: `${iso}#${id}`,
  };
}

/** Both list passes (the page fetch and the COUNT) hit the same command. */
function mockListPages(count: number, items: unknown[]) {
  const respond = (input: { Select?: string }) =>
    input.Select === 'COUNT' ? { Count: count } : { Items: items };
  ddbMock.on(QueryCommand).callsFake(respond);
  ddbMock.on(ScanCommand).callsFake(respond);
}

const fetchInput = (calls: { args: { input: Record<string, unknown> }[] }[]) =>
  calls.find(call => call.args[0].input.Select !== 'COUNT')!.args[0].input;

beforeEach(() => {
  ddbMock.reset();
});

describe('createItem', () => {
  it('writes the current record and VERSION#000001 in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const item = await new DynamoDBStorage().createItem(validItemData());

    expect(item.metadata.version).toBe(1);

    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const [currentPut, versionPut] = calls[0].args[0].input.TransactItems!.map(t => t.Put!);

    expect(currentPut.TableName).toBe('TestExamItems');
    expect(currentPut.Item).toMatchObject({
      PK: `ITEM#${item.id}`,
      SK: 'METADATA',
      GSI1PK: 'SUBJECT#AP Biology',
      GSI2PK: 'STATUS#draft',
    });
    expect(currentPut.ConditionExpression).toBe('attribute_not_exists(PK)');

    expect(versionPut.Item).toMatchObject({ PK: `ITEM#${item.id}`, SK: 'VERSION#000001' });
    // Sparse indexes: history must not appear in list results.
    expect(versionPut.Item!.GSI1PK).toBeUndefined();
    expect(versionPut.Item!.GSI2PK).toBeUndefined();
    expect(versionPut.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});

describe('getItem', () => {
  it('reads by PK/SK and strips the internal key attributes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedRecord({ id: 'abc-123' }) });

    const item = await new DynamoDBStorage().getItem('abc-123');

    expect(item!.id).toBe('abc-123');
    expect(item).not.toHaveProperty('PK');
    expect(item).not.toHaveProperty('GSI1PK');
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'ITEM#abc-123',
      SK: 'METADATA',
    });
  });

  it('returns null when the item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await new DynamoDBStorage().getItem('missing')).toBeNull();
  });
});

describe('updateItem', () => {
  it('bumps the version and appends a snapshot without overwriting history', async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedRecord({ id: 'item-1' }) });
    ddbMock.on(TransactWriteCommand).resolves({});

    const updated = await new DynamoDBStorage().updateItem('item-1', { subject: 'AP Chemistry' });

    expect(updated).toMatchObject({ subject: 'AP Chemistry', metadata: { version: 2 } });

    const [currentPut, versionPut] = ddbMock
      .commandCalls(TransactWriteCommand)[0]
      .args[0].input.TransactItems!.map(t => t.Put!);
    expect(currentPut.Item).toMatchObject({ SK: 'METADATA', subject: 'AP Chemistry' });
    expect(versionPut.Item!.SK).toBe('VERSION#000002');
    expect(versionPut.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('returns null and writes nothing when the item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await new DynamoDBStorage().updateItem('missing', { subject: 'X' })).toBeNull();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('raises ConflictError when a concurrent write already took the next version', async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedRecord({ id: 'item-1' }) });
    ddbMock.on(TransactWriteCommand).rejects(cancelledTransaction('ConditionalCheckFailed'));

    await expect(new DynamoDBStorage().updateItem('item-1', { subject: 'X' })).rejects.toThrow(
      ConflictError
    );
  });

  it('propagates non-conflict cancellations rather than reporting them as conflicts', async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedRecord({ id: 'item-1' }) });
    ddbMock
      .on(TransactWriteCommand)
      .rejects(cancelledTransaction('ThrottlingError'));

    const write = new DynamoDBStorage().updateItem('item-1', { subject: 'X' });
    await expect(write).rejects.toThrow('Transaction cancelled');
    await expect(write).rejects.not.toBeInstanceOf(ConflictError);
  });
});

describe('createVersion', () => {
  it('bumps the version without changing data fields', async () => {
    const existing = storedRecord({ id: 'item-2', version: 3 });
    ddbMock.on(GetCommand).resolves({ Item: existing });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await new DynamoDBStorage().createVersion('item-2');

    expect(result).toMatchObject({ subject: existing.subject, metadata: { version: 4 } });
    const transactItems = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(transactItems[1].Put!.Item!.SK).toBe('VERSION#000004');
  });

  it('returns null for a missing item', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await new DynamoDBStorage().createVersion('missing')).toBeNull();
  });
});

describe('getAuditTrail', () => {
  it('queries the item partition for VERSION# rows and follows the cursor', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [storedRecord({ id: 'item-3', version: 1 })],
        LastEvaluatedKey: { PK: 'ITEM#item-3', SK: 'VERSION#000001' },
      })
      .resolvesOnce({ Items: [storedRecord({ id: 'item-3', version: 2 })] });

    const trail = await new DynamoDBStorage().getAuditTrail('item-3');

    expect(trail.map(v => v.metadata.version)).toEqual([1, 2]);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0].args[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'ITEM#item-3', ':prefix': 'VERSION#' },
      ScanIndexForward: true,
    });
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({
      PK: 'ITEM#item-3',
      SK: 'VERSION#000001',
    });
  });
});

describe('listItems', () => {
  it.each([
    {
      name: 'queries GSI1 for a subject filter',
      query: { subject: 'AP Biology' },
      expected: {
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': 'SUBJECT#AP Biology' },
      },
    },
    {
      name: 'filters GSI1 on status when both filters are given',
      query: { subject: 'AP Biology', status: 'draft' },
      expected: {
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'GSI2PK = :statusPk',
        ExpressionAttributeValues: {
          ':pk': 'SUBJECT#AP Biology',
          ':statusPk': 'STATUS#draft',
        },
      },
    },
    {
      name: 'queries GSI2 for a status-only filter',
      query: { status: 'approved' },
      expected: {
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': 'STATUS#approved' },
      },
    },
  ])('$name', async ({ query, expected }) => {
    mockListPages(1, [storedRecord({ id: 'a' })]);

    const result = await new DynamoDBStorage().listItems(query);

    expect(result.total).toBe(1);
    const input = fetchInput(ddbMock.commandCalls(QueryCommand));
    expect(input).toMatchObject(expected);
    // Newest-first: the ordering bug was sorting a subject's items by status.
    expect(input.ScanIndexForward).toBe(false);
  });

  it('scans the sparse GSI1, not the base table, when no filter is given', async () => {
    mockListPages(5, [storedRecord({ id: 'd' })]);

    const result = await new DynamoDBStorage().listItems({});

    expect(result.total).toBe(5);
    const input = fetchInput(ddbMock.commandCalls(ScanCommand));
    // GSI1 holds exactly one row per current item, so no filter is needed and
    // version rows are never read.
    expect(input.IndexName).toBe('GSI1');
    expect(input.FilterExpression).toBeUndefined();
  });

  it('emulates offset pagination by walking pages and discarding the first `offset` rows', async () => {
    const pages = [
      { Items: [storedRecord({ id: 'a' }), storedRecord({ id: 'b' })], LastEvaluatedKey: { ek: 1 } },
      { Items: [storedRecord({ id: 'c' }), storedRecord({ id: 'd' })], LastEvaluatedKey: { ek: 2 } },
      { Items: [storedRecord({ id: 'e' }), storedRecord({ id: 'f' })] },
    ];
    ddbMock.on(QueryCommand).callsFake(input => {
      if (input.Select === 'COUNT') return { Count: 6 };
      return pages[input.ExclusiveStartKey ? (input.ExclusiveStartKey.ek as number) : 0];
    });

    const result = await new DynamoDBStorage().listItems({ status: 'draft', offset: 3, limit: 2 });

    expect(result.items.map(i => i.id)).toEqual(['d', 'e']);
    expect(result.total).toBe(6);
  });
});
