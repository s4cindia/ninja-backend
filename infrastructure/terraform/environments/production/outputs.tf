# Outputs grow alongside main.tf's module calls -- e.g. the ALB DNS name once
# Phase 4 adds it, the CloudFront domain once Phase 6 adds it, etc.

output "vpc_id" {
  value = module.networking.vpc_id
}

output "public_subnet_ids" {
  value = module.networking.public_subnet_ids
}

output "private_subnet_ids" {
  value = module.networking.private_subnet_ids
}

# Consumed by Phase 5's ECS task definition to assemble DATABASE_URL/
# REDIS_URL at container start -- host/port/name/username are plain (not
# secret) outputs; the one genuinely secret piece per data store is injected
# straight from its own ARN (RDS: AWS's managed secret, via a JSON-key
# selector; Redis: redis_auth_token_secret_arn below).
output "database_endpoint" {
  value = module.database.endpoint
}

output "database_port" {
  value = module.database.port
}

output "database_name" {
  value = module.database.db_name
}

output "database_master_username" {
  value = module.database.master_username
}

output "database_master_user_secret_arn" {
  value = module.database.master_user_secret_arn
}

output "redis_primary_endpoint" {
  value = module.redis.primary_endpoint
}

output "redis_port" {
  value = module.redis.port
}

output "redis_auth_token_secret_arn" {
  value = aws_secretsmanager_secret.redis_auth_token.arn
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "jwt_refresh_secret_arn" {
  value = aws_secretsmanager_secret.jwt_refresh_secret.arn
}

output "download_token_secret_arn" {
  value = aws_secretsmanager_secret.download_token_secret.arn
}

output "anthropic_secret_arn" {
  value = data.aws_secretsmanager_secret.anthropic.arn
}

output "gemini_secret_arn" {
  value = data.aws_secretsmanager_secret.gemini.arn
}

# Consumed by Phase 6 (CloudFront's origin) and Phase 5 (ECS service's
# load_balancer block).
output "alb_dns_name" {
  value = module.alb.alb_dns_name
}

output "alb_http_listener_arn" {
  value = module.alb.http_listener_arn
}

output "web_target_group_arn" {
  value = module.alb.web_target_group_arn
}

output "s3_bucket_name" {
  value = module.storage.bucket_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_execution_role_arn" {
  value = module.iam.execution_role_arn
}

output "ecs_task_role_arn" {
  value = module.iam.task_role_arn
}

output "ecs_web_service_name" {
  value = module.ecs_web.service_name
}

output "ecs_worker_service_name" {
  value = module.ecs_worker.service_name
}

output "cloudfront_domain_name" {
  value = module.cloudfront.domain_name
}
