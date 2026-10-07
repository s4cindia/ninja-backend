terraform {
  required_version = ">= 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Refuses to run at all if the credentials in use don't belong to the
  # expected account -- a real, cheap safety net: this session's own AWS
  # identity turned out to be in a completely different account than
  # Ninja's real infrastructure, discovered only by a failed API call.
  # This makes that class of mistake fail loudly before touching anything.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Application = "ninja"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
