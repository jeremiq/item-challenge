import * as path from 'path';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface ItemChallengeStackProps extends StackProps {
  readonly envConfig: EnvConfig;
}

/** One route: its Lambda, the DynamoDB actions it may perform, and where it hangs off the API. */
interface RouteDefinition {
  /** Construct id, and the adapter export name in lambda-adapters/index.ts. */
  readonly id: string;
  readonly handlerExport: string;
  readonly method: string;
  readonly path: 'items' | 'item' | 'versions' | 'audit';
  /**
   * Least-privilege DynamoDB actions. Deliberately enumerated per route rather
   * than using grantReadWriteData(), which would hand every function the union
   * of Get/Query/Scan/Put/Update/Delete.
   */
  readonly actions: string[];
}

// The storage layer (../../src/storage/dynamodb.ts) drives these permissions:
// writes go through TransactWriteCommand, which needs TransactWriteItems on top
// of the underlying per-item action — granting only PutItem yields AccessDenied
// at runtime while looking correct here. listItems falls back to a Scan when no
// subject/status filter is given, so it needs Scan as well as Query.
const ROUTES: RouteDefinition[] = [
  {
    id: 'CreateItem',
    handlerExport: 'createItem',
    method: 'POST',
    path: 'items',
    actions: ['dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
  },
  {
    id: 'ListItems',
    handlerExport: 'listItems',
    method: 'GET',
    path: 'items',
    actions: ['dynamodb:Query', 'dynamodb:Scan'],
  },
  {
    id: 'GetItem',
    handlerExport: 'getItem',
    method: 'GET',
    path: 'item',
    actions: ['dynamodb:GetItem'],
  },
  {
    id: 'UpdateItem',
    handlerExport: 'updateItem',
    method: 'PUT',
    path: 'item',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
  },
  {
    id: 'CreateVersion',
    handlerExport: 'createVersion',
    method: 'POST',
    path: 'versions',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
  },
  {
    id: 'GetAuditTrail',
    handlerExport: 'getAuditTrail',
    method: 'GET',
    path: 'audit',
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
  },
];

/**
 * Infrastructure for the exam item management API:
 * API Gateway (REST) -> 6 single-purpose Lambdas -> one DynamoDB table.
 */
export class ItemChallengeStack extends Stack {
  constructor(scope: Construct, id: string, props: ItemChallengeStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // Single-table design: current item state and version history share a
    // partition, so an item's CRUD and its full audit trail are each a single
    // Query rather than a fan-out across tables. Key schema and GSI layout are
    // defined and documented in ../../src/storage/dynamodb.ts.
    //
    // On-demand billing: exam authoring is bursty and low-volume with no steady
    // baseline to size provisioned RCU/WCU against. Provisioned capacity only
    // pays off at sustained, predictable throughput.
    const table = new dynamodb.Table(this, 'ItemsTable', {
      tableName: `item-challenge-items-${envConfig.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: envConfig.removalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: envConfig.envName === 'prod',
      },
    });

    // Both GSIs are sparse: their keys are only written on SK=METADATA records,
    // never on VERSION# snapshots, so each index holds exactly one row per item
    // and list results need no filtering to exclude history. That sparseness is
    // also what makes an unfiltered list affordable — it Scans GSI1 rather than
    // the base table, and so never reads version rows at all.
    //
    // Both sort on lastModified so every filtered list is newest-first.
    //
    // Projection ALL, not KEYS_ONLY: list responses need the whole item, and a
    // follow-up GetItem per row would defeat the point of an index-backed list.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1', // list by subject (status applied as a filter)
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2', // list by status alone
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // REST API rather than the cheaper HTTP API: request validators, usage
    // plans/API keys and WAF association are all directly useful for content
    // classified by securityLevel, and at 6 routes the cost delta is negligible.
    const api = new apigateway.RestApi(this, 'ItemChallengeApi', {
      restApiName: `item-challenge-api-${envConfig.envName}`,
      description: 'Exam item management API',
      deployOptions: {
        stageName: envConfig.envName,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        // Permissive for the exercise; a real deployment would scope this to
        // the authoring tool's origin(s).
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const apiResource = api.root.addResource('api');
    const itemsResource = apiResource.addResource('items');
    const itemResource = itemsResource.addResource('{id}');
    const resources: Record<RouteDefinition['path'], apigateway.IResource> = {
      items: itemsResource,
      item: itemResource,
      versions: itemResource.addResource('versions'),
      audit: itemResource.addResource('audit'),
    };

    // Every route Lambda bundles from the same adapter module; `handler` picks
    // the export. NodejsFunction runs esbuild itself, so there's no separate
    // build/zip step. The AWS SDK is excluded by default on Node 18+ runtimes
    // since the runtime already provides it.
    const entry = path.join(__dirname, '..', 'lambda-adapters', 'index.ts');

    for (const route of ROUTES) {
      const logGroup = new logs.LogGroup(this, `${route.id}LogGroup`, {
        logGroupName: `/aws/lambda/item-challenge-${route.id}-${envConfig.envName}`,
        retention: envConfig.logRetention,
        removalPolicy: envConfig.removalPolicy,
      });

      // No `role` prop, so each function gets its own execution role and the
      // grant below applies to that function alone.
      const fn = new NodejsFunction(this, route.id, {
        entry,
        handler: route.handlerExport,
        runtime: Runtime.NODEJS_24_X,
        memorySize: 256,
        timeout: Duration.seconds(10),
        logGroup,
        environment: {
          // Names dictated by src/storage/: createStorage() only returns
          // DynamoDBStorage when USE_DYNAMODB is 'true' — otherwise each Lambda
          // silently gets its own empty in-memory store. AWS_REGION is set by
          // the Lambda runtime itself.
          USE_DYNAMODB: 'true',
          DYNAMODB_TABLE_NAME: table.tableName,
          ...(envConfig.envName === 'prod' ? {} : { NODE_OPTIONS: '--enable-source-maps' }),
        },
        bundling: {
          minify: true,
          sourceMap: true,
          // Don't embed original sources in the .map — several times the
          // artifact size across 6 functions, for no production benefit.
          sourcesContent: false,
          // esbuild has no node24 target; node22 output runs on Node.js 24.
          target: 'node22',
        },
      });

      table.grant(fn, ...route.actions);
      resources[route.path].addMethod(route.method, new apigateway.LambdaIntegration(fn));
    }

    new CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'Base URL of the deployed API',
    });
    new CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });
  }
}
