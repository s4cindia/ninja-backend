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

# Secret ARNs -- consumed by Phase 5's ECS task definition `secrets` block,
# the same way deploy-backend-staging.yml's own STAGING_*_SECRET_ARN GitHub
# secrets are consumed today.
output "database_url_secret_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "redis_url_secret_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
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
