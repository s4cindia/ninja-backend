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
