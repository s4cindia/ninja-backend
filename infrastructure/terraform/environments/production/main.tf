# Root module for the Ninja production environment.
#
# Grows module-call by module-call as each phase of the production rollout
# plan is built and approved, rather than all at once:
#   Phase 2: networking (VPC, subnets, security groups) -- DONE, below
#   Phase 3: secrets, RDS, ElastiCache Redis -- DONE, below
#   Phase 4: ALB + target groups -- DONE, below
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

# --- Phase 4: ALB + target groups ---
module "alb" {
  source = "../../modules/alb"

  environment       = "production"
  vpc_id            = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids
  security_group_id = module.networking.alb_security_group_id
  app_port          = 3000
  health_check_path = "/health"
}

# --- Phase 5: S3 storage, IAM roles, ECS cluster + web/worker services ---

# Real gap caught designing this phase: no earlier phase created a
# production file-storage bucket. config/index.ts's own S3_BUCKET fallback
# default is literally the STAGING bucket name ("ninja-epub-staging"), so
# this has to exist before the task definitions below can safely reference
# it -- see also Phase 10's planned fail-fast fix for that silent-fallback
# behavior in the app code itself.
module "storage" {
  source = "../../modules/storage"

  environment = "production"
}

module "iam" {
  source = "../../modules/iam"

  environment   = "production"
  s3_bucket_arn = module.storage.bucket_arn
  secret_arns = [
    module.database.master_user_secret_arn,
    aws_secretsmanager_secret.redis_auth_token.arn,
    aws_secretsmanager_secret.jwt_secret.arn,
    aws_secretsmanager_secret.jwt_refresh_secret.arn,
    aws_secretsmanager_secret.download_token_secret.arn,
    data.aws_secretsmanager_secret.anthropic.arn,
    data.aws_secretsmanager_secret.gemini.arn,
  ]
}

resource "aws_ecs_cluster" "this" {
  name = "ninja-production-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "ninja-production-cluster"
  }
}

# DATABASE_URL/REDIS_URL are composed HERE, at container start, from
# separately-injected plain + secret pieces -- never as a single combined
# value Terraform itself assembles. This is a direct continuation of the
# Phase 3 CodeRabbit-driven redesign (PR #643): the RDS password and Redis
# auth token each flow straight from their own Secrets Manager ARN into the
# container, and this one-line shell wrapper (no Docker image change
# needed -- it overrides the image's own CMD) is what turns them into the
# single connection-string env vars Prisma/ioredis actually read.
#
# Assumption, documented rather than silently relied on: AWS's
# manage_master_user_password-generated RDS password is generated excluding
# URL-breaking characters (", @, /, space) by default, so naive string
# concatenation here is safe without shell-level URL-encoding. Revisit if
# this ever causes a connection failure.
locals {
  app_command = [
    "sh", "-c",
    "export DATABASE_URL=\"postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME\"; export REDIS_URL=\"rediss://:$REDIS_AUTH_TOKEN@$REDIS_HOST:$REDIS_PORT\"; exec node dist/index.js"
  ]

  app_plain_environment = [
    { name = "DB_HOST", value = module.database.endpoint },
    { name = "DB_PORT", value = tostring(module.database.port) },
    { name = "DB_NAME", value = module.database.db_name },
    { name = "DB_USER", value = module.database.master_username },
    { name = "REDIS_HOST", value = module.redis.primary_endpoint },
    { name = "REDIS_PORT", value = tostring(module.redis.port) },
  ]

  app_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${module.database.master_user_secret_arn}:password::" },
    { name = "REDIS_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.redis_auth_token.arn },
    { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
    { name = "JWT_REFRESH_SECRET", valueFrom = aws_secretsmanager_secret.jwt_refresh_secret.arn },
    { name = "DOWNLOAD_TOKEN_SECRET", valueFrom = aws_secretsmanager_secret.download_token_secret.arn },
    { name = "ANTHROPIC_API_KEY", valueFrom = data.aws_secretsmanager_secret.anthropic.arn },
    { name = "GEMINI_API_KEY", valueFrom = data.aws_secretsmanager_secret.gemini.arn },
  ]
}

module "ecs_web" {
  source = "../../modules/ecs-service"

  environment        = "production"
  service_role       = "web"
  cluster_id         = aws_ecs_cluster.this.id
  cluster_name       = aws_ecs_cluster.this.name
  execution_role_arn = module.iam.execution_role_arn
  task_role_arn      = module.iam.task_role_arn
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.ecs_security_group_id
  cpu                = 1024
  memory             = 2048
  desired_count      = 1
  s3_bucket_name     = module.storage.bucket_name
  command            = local.app_command
  extra_environment  = local.app_plain_environment
  secrets            = local.app_secrets
  attach_to_alb      = true
  target_group_arn   = module.alb.web_target_group_arn
}

module "ecs_worker" {
  source = "../../modules/ecs-service"

  environment        = "production"
  service_role       = "worker"
  cluster_id         = aws_ecs_cluster.this.id
  cluster_name       = aws_ecs_cluster.this.name
  execution_role_arn = module.iam.execution_role_arn
  task_role_arn      = module.iam.task_role_arn
  private_subnet_ids = module.networking.private_subnet_ids
  security_group_id  = module.networking.ecs_security_group_id
  # Mirrors staging's real ninja-backend-worker-task-definition.json
  # (cpu/memory) -- PDF/EPUB processing is heavier than the web service's
  # own request handling.
  cpu            = 2048
  memory         = 8192
  desired_count  = 1
  s3_bucket_name = module.storage.bucket_name
  command        = local.app_command
  # Deliberately NOT including staging's YOLO_SERVICE_URL/YOLO_WARM_*_HOUR_IST
  # here -- that points at staging's own Cloud Map DNS name
  # (ninja-zone-detector.ninja.local), which doesn't exist in production's
  # separate VPC. Production has no zone-detector service yet (Phase 8).
  # Leaving these unset matches the codebase's own established convention:
  # Seam-C/YOLO features gate on their own env vars and degrade safely when
  # unset, same as every other optional integration this session (axes4,
  # docling, etc.).
  extra_environment = local.app_plain_environment
  secrets           = local.app_secrets
}

# --- Phase 6: CloudFront ---
module "cloudfront" {
  source = "../../modules/cloudfront"

  environment  = "production"
  alb_dns_name = module.alb.alb_dns_name
}
