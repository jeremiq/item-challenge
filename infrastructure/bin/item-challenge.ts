#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ItemChallengeStack } from '../lib/item-challenge-stack';
import { resolveEnvConfig } from '../lib/config';

const app = new cdk.App();

// `cdk synth --context env=dev|prod`, defaulting to dev. Account/region come
// from the CLI's default profile, so synth works with no AWS config at all.
const envConfig = resolveEnvConfig(app.node.tryGetContext('env'));

new ItemChallengeStack(app, `ItemChallengeStack-${envConfig.envName}`, {
  envConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: {
    project: 'item-challenge',
    environment: envConfig.envName,
  },
});
