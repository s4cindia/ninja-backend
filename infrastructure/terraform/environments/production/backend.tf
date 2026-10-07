# Remote state backend -- see ../../bootstrap/README.md for how these
# resources were created (one-time, manual, not Terraform-managed).
terraform {
  backend "s3" {
    bucket         = "ninja-terraform-state-223643972423"
    key            = "production/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "ninja-terraform-locks"
    encrypt        = true
  }
}
