# Remote state backend -- see ../../bootstrap/README.md for how these
# resources were created (one-time, manual, not Terraform-managed).
terraform {
  backend "s3" {
    bucket = "ninja-terraform-state-223643972423"
    key    = "production/terraform.tfstate"
    region = "ap-south-1"
    # Both locking mechanisms run side by side from day one -- HashiCorp is
    # deprecating DynamoDB locking in favor of S3-native conditional-write
    # locking, but since this is a brand-new backend with no prior applies,
    # there's no "migrate existing locks" step needed: just start with both.
    dynamodb_table = "ninja-terraform-locks"
    use_lockfile   = true
    encrypt        = true
  }
}
