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

resource "aws_security_group" "alb" {
  name        = "ninja-${var.environment}-alb-sg"
  description = "Ingress from the internet on 443/80; egress to ECS tasks only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from anywhere (redirect to HTTPS at the listener)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
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
