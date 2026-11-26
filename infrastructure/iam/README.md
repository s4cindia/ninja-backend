# infrastructure/iam

`ninja-backend-task-role` (used by both `ninja-backend-worker-task-definition.json`
and the docling task definitions) is **not** Terraform-managed — it was created
by hand via the AWS Console on staging (same one-time-Console pattern as the
ECS services it's attached to; see `deploy-backend-worker-staging.yml`'s own
comments). Policy documents for it live here as plain JSON, applied by hand,
instead of as Terraform resources the rest of `infrastructure/` uses.

## ninja-backend-task-role-zone-detection-cache-policy.json

Real gap found 2026-11-26: `ZoneDetectionCache` (see `schema.prisma` and
`src/services/zone-extractor/zone-detection-cache.service.ts`) calls SSM
`GetParameter` on `/ninja/zone-extractor/model-weights-path` and S3
`HeadObject` (IAM action `s3:GetObject` — S3 has no separate `HeadObject`
action; it's authorized under `GetObject`) on the weights object it points
to, to build a cache key without ever waking the GPU zone-detector service.
`ninja-backend-task-role` never needed either permission before this cache
existed (only the zone-detector service's own, separate role read the actual
weights file). Without them, every lookup/store throws, is caught by the
non-fatal try/catch in `seam-c-tag.service.ts`, and silently falls through to
normal (fresh, non-deterministic) detection every time — diagnosed by reading
the code (no CloudWatch access from the dev environment), not yet confirmed
via the cache's own job.output outcome field (`zoneDetectionCache`, see
`SeamCTagResult`), which exists so the NEXT run can confirm it directly.

The policy's `Resource` is already filled in with the real bucket
(`ninja-epub-staging`, same bucket as `S3_BUCKET` in the worker task
definition), resolved from the SSM parameter's current value --

```
aws ssm get-parameter --name /ninja/zone-extractor/model-weights-path --query Parameter.Value --output text --region ap-south-1
```

That returns an `s3://bucket/key` URI (the key changes on every model
promotion -- see `evaluation.service.ts`'s `promoteTrainingRun`, which calls
`ssm:PutParameter` with a new `onnxS3Path` each time -- so the policy is
scoped to the whole bucket with a wildcard key, not one object). Re-run that
command and update the policy's `Resource` if the weights ever move to a
different bucket.

Apply with:

```
aws iam put-role-policy \
  --role-name ninja-backend-task-role \
  --policy-name ZoneDetectionCacheWeightsIdentity \
  --policy-document file://infrastructure/iam/ninja-backend-task-role-zone-detection-cache-policy.json
```

Confirm it took:

```
aws iam get-role-policy --role-name ninja-backend-task-role --policy-name ZoneDetectionCacheWeightsIdentity
```

No ECS redeploy needed — IAM role policies apply to a task's existing
credentials on the next AWS SDK call, not at container start.
