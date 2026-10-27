# AWS Marketplace reconciliation worker

This worker receives AWS Marketplace license notifications and checks the current entitlement for each license. It never grants access from event content. A five-minute schedule also checks licenses that are due, so a missed event cannot keep access alive. Convex stops fresh access after fifteen minutes without a completed verification.

## Build and deploy

Use Node.js 24 and the repository's pinned dependencies. From the repository root:

```sh
mkdir -p /tmp/aws-marketplace-worker
./node_modules/.bin/esbuild workers/aws-marketplace/index.ts --bundle --platform=node --target=node24 --format=esm --outfile=/tmp/aws-marketplace-worker/index.mjs
cd /tmp/aws-marketplace-worker && zip -q worker.zip index.mjs
aws s3 cp worker.zip s3://YOUR_PRIVATE_ARTIFACT_BUCKET/aws-marketplace/worker.zip
aws cloudformation deploy --region us-east-1 --template-file /path/to/worldmonitor/workers/aws-marketplace/template.yaml --stack-name worldmonitor-aws-marketplace --capabilities CAPABILITY_IAM --parameter-overrides file:///path/to/protected-marketplace-parameters.json
```

The private parameter file supplies `ArtifactBucket`, `ArtifactKey`, `ProductCodes`, `DimensionPlanMap`, `ConvexSiteUrl`, `ConvexSharedSecret`, and `SellerAccountId`. Keep it outside the repository and restrict access. Set the `ConvexSharedSecret` value to the existing server trust secret. The worker uses its Lambda role credentials for `GetEntitlements`. Use an AWS account and `us-east-1` where the seller receives Marketplace events. The Vercel registration endpoint separately needs AWS credentials with only `ResolveCustomer` and `GetEntitlements`, plus the same product, dimension, Convex URL, and buyer origin settings. Verify the AWS product, dimension, plan mapping, and published listing before any buyer setup.

CloudFormation creates the EventBridge rule, encrypted SQS queue, DLQ, Lambda role, five-minute schedule, and DLQ alarm. Set an alarm action in your monitoring system after deployment. The stack sets CloudWatch log retention to 365 days. Limit read access to that log group and protect any exported security logs. Convex records append-only license and key audit facts, but its table alone is not a tamperproof archive. Define an export and retention policy before production acceptance.

## Recovery

Check the DLQ alarm and Lambda failures. Fix the credential, AWS, Convex, or invalid-message cause first. Redrive DLQ messages to the source queue through the SQS console or `start-message-move-task`. Do not edit event bodies or infer entitlement from them. The worker rechecks AWS during replay. Duplicate completed events are safe. A revision conflict remains in the queue for retry. Inspect the scheduled invocation and the Convex due list after recovery. Verify an affected license's `checkedAt`, current status, and fresh API/MCP denial or allowance. Do not report production acceptance from a successful stack deployment alone.
