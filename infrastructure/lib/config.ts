import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Environment-specific configuration.
 *
 * One stack definition parameterized by this config, selected via CDK context
 * (`--context env=prod`, default `dev`), rather than separate per-env stack
 * classes that would drift apart.
 */
export type EnvName = 'dev' | 'prod';

export interface EnvConfig {
  readonly envName: EnvName;

  /**
   * Applied to the table and the log groups. RETAIN in prod so a stack
   * replacement or an accidental `cdk destroy` can't take exam content — or the
   * logs recording who changed it — with it.
   */
  readonly removalPolicy: RemovalPolicy;

  readonly logRetention: RetentionDays;
}

export const ENV_CONFIGS: Record<EnvName, EnvConfig> = {
  dev: {
    envName: 'dev',
    removalPolicy: RemovalPolicy.DESTROY,
    logRetention: RetentionDays.ONE_WEEK,
  },
  prod: {
    envName: 'prod',
    removalPolicy: RemovalPolicy.RETAIN,
    logRetention: RetentionDays.ONE_MONTH,
  },
};

export function resolveEnvConfig(envName: string | undefined): EnvConfig {
  const config = ENV_CONFIGS[(envName ?? 'dev') as EnvName];
  if (!config) {
    throw new Error(
      `Unknown env "${envName}". Valid values: ${Object.keys(ENV_CONFIGS).join(', ')}.`,
    );
  }
  return config;
}
