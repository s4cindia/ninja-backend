# Root module for the Ninja production environment.
#
# Grows module-call by module-call as each phase of the production rollout
# plan is built and approved, rather than all at once:
#   Phase 2: networking (VPC, subnets, security groups) -- DONE, below
#   Phase 3: secrets, RDS, ElastiCache Redis -- DONE, below
#   Phase 4: ALB + target groups
#   Phase 5: ECS cluster + backend web/worker services
#   Phase 6: CloudFront
#   Phase 8: ACE, docling (CPU+GPU), zone-detector, training services
#
# See the Phase 0 audit findings (nothing production-related exists yet --
# this is a clean build) for why there's nothing to `import` here.

# Dedicated production VPC -- deliberately separate from staging's shared
# "s4c-nonprod-vpc" (10.101.0.0/16). 10.102.0.0/16 keeps the same addressing
# scheme without overlapping it or the Control Tower default VPC
# (172.31.0.0/16). Same 2-AZ, public/private-subnet, single-NAT-Gateway
# topology staging actually runs (confirmed via direct AWS audit, not
# assumed) -- not a from-scratch design.
module "networking" {
  source = "../../modules/networking"

  environment          = "production"
  vpc_cidr             = "10.102.0.0/16"
  azs                  = ["ap-south-1a", "ap-south-1b"]
  public_subnet_cidrs  = ["10.102.0.0/24", "10.102.1.0/24"]
  private_subnet_cidrs = ["10.102.10.0/24", "10.102.11.0/24"]
  app_port             = 3000
}

# --- Phase 3: data stores + secrets ---
#
# Every secret below is either AWS-managed (RDS master password) or
# Terraform-generated (random_password) -- no human ever types or pastes a
# production secret value anywhere, matching the discipline this project
# already used for the axes4 trial key. The two exceptions are
# ANTHROPIC_API_KEY/GEMINI_API_KEY, which deliberately REUSE staging's
# existing secrets by reference (the user's own decision: same keys in both
# environments) rather than duplicating the value into a new secret that
# could drift out of sync on rotation.

resource "random_password" "jwt_secret" {
  length  = 64
  special = false

  # Regenerating this would invalidate every issued JWT in one shot --
  # require a deliberate `terraform state rm`/import, never an accidental
  # destroy/replace (CodeRabbit catch on PR #643's first version).
  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "jwt_refresh_secret" {
  length  = 64
  special = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "download_token_secret" {
  length  = 64
  special = false

  lifecycle {
    prevent_destroy = true
  }
}

# ElastiCache AUTH tokens have their own character-set restriction (no
# !, &, #, $, ^, <, >, |), so this can't just reuse a generic random_password
# with `special = true`.
resource "random_password" "redis_auth_token" {
  length           = 64
  special          = true
  override_special = "-_."

  lifecycle {
    prevent_destroy = true
  }
}

module "database" {
  source = "../../modules/database"

  environment        = "production"
  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.rds_security_group_id
}

module "redis" {
  source = "../../modules/redis"

  environment        = "production"
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.redis_security_group_id
  auth_token         = random_password.redis_auth_token.result
}

# No composed DATABASE_URL/REDIS_URL secret is created here (removed after
# a CodeRabbit catch on PR #643's first version): Phase 5's ECS task
# definition assembles each connection string at container start from
# individually-injected, non-secret pieces (host/port/dbname/username below,
# all plain outputs) plus the one genuinely secret piece per data store
# (RDS: AWS's own managed-secret ARN with a JSON-key selector; Redis: the
# token secret below) -- so no plaintext credential ever has to pass through
# Terraform state as a composed string.

resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "ninja/production/jwt-secret"
  # Explicit (matches the AWS default, but documents intent): a
  # fat-fingered delete is recoverable for 30 days rather than immediate.
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt_secret.result
}

resource "aws_secretsmanager_secret" "jwt_refresh_secret" {
  name                    = "ninja/production/jwt-refresh-secret"
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "jwt_refresh_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_refresh_secret.id
  secret_string = random_password.jwt_refresh_secret.result
}

resource "aws_secretsmanager_secret" "download_token_secret" {
  name                    = "ninja/production/download-token-secret"
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "download_token_secret" {
  secret_id     = aws_secretsmanager_secret.download_token_secret.id
  secret_string = random_password.download_token_secret.result
}

resource "aws_secretsmanager_secret" "redis_auth_token" {
  name                    = "ninja/production/redis-auth-token"
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "redis_auth_token" {
  secret_id     = aws_secretsmanager_secret.redis_auth_token.id
  secret_string = random_password.redis_auth_token.result
}

# Reused (not duplicated) from staging -- per the user's own decision to
# share the same Anthropic/Gemini keys across both environments. Referenced
# by name via data source, not copied into a new secret.
#
# Cross-environment dependency, flagged explicitly (CodeRabbit catch on PR
# #643's first version): production's `terraform plan`/`apply` will FAIL if
# either staging secret is ever renamed or deleted. Keep both retained in
# staging for as long as production depends on them here.
data "aws_secretsmanager_secret" "anthropic" {
  name = "ninja/staging/anthropic"
}

data "aws_secretsmanager_secret" "gemini" {
  name = "ninja/staging/gemini"
}
