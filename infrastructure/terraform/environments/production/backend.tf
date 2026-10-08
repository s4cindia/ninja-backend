# Remote state backend -- see ../../bootstrap/README.md for how these
# resources were created (one-time, manual, not Terraform-managed).
terraform {
  backend "s3" {
    bucket = "ninja-terraform-state-223643972423"
    key    = "production/terraform.tfstate"
    region = "ap-south-1"
    # S3-native locking only -- the ninja-terraform-locks DynamoDB table
    # (see bootstrap/README.md) turned out to need IAM permissions
    # (dynamodb:GetItem/PutItem) this account's user doesn't have, discovered
    # on the very first real `terraform plan`. Since DynamoDB locking never
    # actually succeeded even once, there's no "migrate existing locks" step
    # needed -- just drop it in favor of the mechanism HashiCorp is pushing
    # toward anyway. The table itself is left in place, unused and
    # zero-cost (PAY_PER_REQUEST with no traffic) -- re-add dynamodb_table
    # here if its IAM policy is ever fixed and dual-locking is wanted again.
    use_lockfile = true
    encrypt      = true
  }
}
