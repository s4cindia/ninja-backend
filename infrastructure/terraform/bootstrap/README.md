# Terraform state bootstrap

One-time, manual setup for Terraform's own remote state backend. Not managed by
Terraform itself (a backend can't manage the bucket it stores its state in) —
these resources were created directly via AWS CLI on 2026-10-07 and should
never need to change.

## Resources

| Resource | Name | Purpose |
|---|---|---|
| S3 bucket | `ninja-terraform-state-223643972423` | Stores `*.tfstate` files, one key per environment (e.g. `production/terraform.tfstate`). Versioned, SSE-AES256 encrypted, all public access blocked. |
| DynamoDB table | `ninja-terraform-locks` | State locking (prevents two concurrent `terraform apply` runs from corrupting state). Partition key `LockID` (String), on-demand billing. |

Region: `ap-south-1` (same as every other Ninja AWS resource).

## If this ever needs recreating

```bash
aws s3api create-bucket \
  --bucket ninja-terraform-state-223643972423 \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-bucket-versioning \
  --bucket ninja-terraform-state-223643972423 \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket ninja-terraform-state-223643972423 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket ninja-terraform-state-223643972423 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws dynamodb create-table \
  --table-name ninja-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1
```

Every environment under `../environments/*/backend.tf` points at this same
bucket/table, with a distinct `key` path per environment so state never
collides.
