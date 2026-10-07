# Root module for the Ninja production environment.
#
# Intentionally empty of resources for now -- this file grows module-call by
# module-call as each phase of the production rollout plan is built and
# approved, rather than all at once:
#   Phase 2: networking (VPC, subnets, security groups)
#   Phase 3: secrets, RDS, ElastiCache Redis
#   Phase 4: ALB + target groups
#   Phase 5: ECS cluster + backend web/worker services
#   Phase 6: CloudFront
#   Phase 8: ACE, docling (CPU+GPU), zone-detector, training services
#
# See the Phase 0 audit findings (nothing production-related exists yet --
# this is a clean build) for why there's nothing to `import` here.
