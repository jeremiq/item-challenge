# Infrastructure (AWS CDK, TypeScript)

Deploys the exam item management API: API Gateway (REST) -> 6 Lambda functions
(one per endpoint) -> one DynamoDB table.

Design rationale lives in the root [ARCHITECTURE.md](../ARCHITECTURE.md);
`lib/item-challenge-stack.ts` has the resource definitions and
`lib/config.ts` the dev/prod differences.

## Setup

```bash
cd infrastructure
npm install
```

Node 22+. No AWS credentials are needed for `cdk synth` — it's pure template
generation. `cdk diff`/`deploy` need credentials and a bootstrapped account.

## Commands

```bash
# Validate the stack (writes CloudFormation to cdk.out/, makes no AWS calls)
npx cdk synth --context env=dev
npx cdk synth --context env=prod

# Compare against, or deploy to, a real account
npx cdk diff --context env=dev
npx cdk deploy --context env=dev
```

`--context env` defaults to `dev`. Each environment synthesizes its own stack
(`ItemChallengeStack-dev` / `-prod`), so both can coexist in one account.

| | dev | prod |
|---|---|---|
| Table / log group removal policy | `DESTROY` | `RETAIN` |
| Point-in-time recovery | off | on |
| CloudWatch log retention | 1 week | 1 month |
| Source maps enabled at runtime | yes | no |

## Lambda code

The handlers in `../src/handlers/items.ts` take parsed arguments and return
`{ statusCode, body }` with an object body, so that the same code can back both
the local dev server and Lambda. `lambda-adapters/index.ts` translates between
that shape and API Gateway's proxy event/response; every function deploys from
that one file, selected by export name via `NodejsFunction`'s `handler` prop.

## Known gaps

- No authentication/authorization on the API Gateway methods
  (`AuthorizationType: NONE`), and CORS is wide open. Given the `securityLevel`
  field on items, a production version needs an authorizer plus
  per-securityLevel checks.
- No WAF, usage plan, or API key — REST API was chosen partly to keep those
  available, but they're left for a real deployment to configure.
