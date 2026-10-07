# Root module for the Ninja production environment.
#
# Grows module-call by module-call as each phase of the production rollout
# plan is built and approved, rather than all at once:
#   Phase 2: networking (VPC, subnets, security groups) -- DONE, below
#   Phase 3: secrets, RDS, ElastiCache Redis
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
