# Dedicated VPC for this environment -- a deliberate deviation from staging,
# which shares "s4c-nonprod-vpc" with the ACE microservice. Phase 0's audit
# confirmed no production VPC exists yet, so there's no existing resource to
# reconcile here. Mirrors staging's actual topology otherwise: 2 AZs, public
# subnets for the ALB, private subnets (NAT-routed) for ECS/RDS/Redis, one
# NAT Gateway (staging also runs exactly one, not one-per-AZ).

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "ninja-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "ninja-${var.environment}-igw"
  }
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "ninja-${var.environment}-public-${var.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.azs[count.index]

  tags = {
    Name = "ninja-${var.environment}-private-${var.azs[count.index]}"
    Tier = "private"
  }
}

# Single NAT Gateway, in the first public subnet -- matches staging's real
# topology (one NAT, not HA). A second can be added later per-AZ without
# re-architecting anything, if production resilience requirements change.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "ninja-${var.environment}-nat-eip"
  }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "ninja-${var.environment}-nat"
  }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "ninja-${var.environment}-public-rt"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = {
    Name = "ninja-${var.environment}-private-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- Security groups: ALB -> ECS tasks -> RDS/Redis, each hop least-privilege ---
# Mirrors the ACE staging pattern (ninja-alb-staging's SG -> ace-ecs-sg) rather
# than inventing a new shape.

# CloudFront (Phase 6) sits in front of this ALB -- the ALB itself must only
# accept traffic that genuinely came from a CloudFront edge, not the raw
# internet, or anyone could bypass CloudFront entirely (and whatever WAF/
# caching/geo rules live there) by hitting the ALB's own public DNS name
# directly. AWS publishes exactly this as a managed prefix list (CodeRabbit
# catch on PR #646, applied here rather than suppressed).
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  # name_prefix (not a static name) + create_before_destroy below: this
  # specific security group just deadlocked a real apply when a prior
  # change forced its replacement -- a static name collides with its own
  # replacement while both briefly exist, and destroy-before-create (the
  # default) can't complete while ecs_tasks' rule still references the old
  # one, which can't be updated until the new one exists. Deliberately
  # scoped to ONLY this security group: ecs_tasks/rds/redis are already
  # attached to live resources (Phase 3's real RDS/Redis), so forcing the
  # same change onto them would risk the identical deadlock against
  # production data stores that are actually serving traffic.
  name_prefix = "ninja-${var.environment}-alb-sg-"
  # No apostrophe (real AWS error on the first live apply attempt: EC2
  # security group descriptions only allow a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
  # -- "CloudFront's" isn't valid).
  description = "Ingress from the CloudFront edge network only (80); egress to ECS tasks only."
  vpc_id      = aws_vpc.this.id

  lifecycle {
    create_before_destroy = true
  }

  # No port 443 rule: real AWS error on the actual apply --
  # RulesPerSecurityGroupLimitExceeded. A security-group rule referencing a
  # managed prefix list counts EVERY entry in that list toward the group's
  # rule quota, not just "1 rule" -- the CloudFront origin-facing list has
  # 46 real entries (confirmed via `aws ec2 get-managed-prefix-list-entries`
  # against the real account), so referencing it on both 80 and 443 needed
  # 92 slots against AWS's default 60-per-group limit. There's no HTTPS
  # listener yet anyway (Phase 4 built HTTP only, per the no-custom-domain
  # decision), so this rule was unused dead weight. Re-add it (and request
  # a quota increase first) if/when a custom domain + ACM cert + HTTPS
  # listener are added later.

  ingress {
    description     = "HTTP from CloudFront edges only"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  }

  egress {
    description = "To ECS tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name = "ninja-${var.environment}-alb-sg"
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "ninja-${var.environment}-ecs-sg"
  description = "Ingress from the ALB on the app port only; egress anywhere (ECR pulls, Anthropic/Gemini/axes4 API calls)."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From ALB"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Anywhere (external APIs, ECR, etc. via NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "ninja-${var.environment}-ecs-sg"
  }
}

# Standalone rule resource, not an inline block on aws_security_group.alb --
# ecs_tasks's own ingress rule above already references aws_security_group.
# alb.id, so an inline block here referencing aws_security_group.ecs_tasks.id
# back would make the two security groups depend on each other and deadlock
# Terraform's graph. A separate rule resource breaks the cycle: it depends on
# both already-existing security groups without either SG RESOURCE itself
# depending on the other.
#
# Needed for Phase 8's ACE routing: ninja-backend calls http://<alb-dns>/ace
# (ACE_SERVICE_URL) directly from inside the VPC, not via CloudFront -- the
# alb security group's CloudFront-only ingress rule above would otherwise
# silently drop that request before it ever reached the listener/target-group
# routing that's supposed to forward it to ACE.
resource "aws_security_group_rule" "alb_ingress_from_ecs_tasks" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = aws_security_group.alb.id
  source_security_group_id = aws_security_group.ecs_tasks.id
  description              = "HTTP from ninja-backend itself (internal /ace routing)"
}

resource "aws_security_group" "rds" {
  name        = "ninja-${var.environment}-rds-sg"
  description = "Postgres ingress from ECS tasks only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Postgres from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "ninja-${var.environment}-rds-sg"
  }
}

resource "aws_security_group" "redis" {
  name        = "ninja-${var.environment}-redis-sg"
  description = "Redis ingress from ECS tasks only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Redis from ECS tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "ninja-${var.environment}-redis-sg"
  }
}
