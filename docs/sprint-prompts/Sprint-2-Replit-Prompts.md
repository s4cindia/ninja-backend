# Sprint 2 Replit Prompts
## AWS Infrastructure + CI/CD + AI Integration

**Version:** 3.0 - VPAT/ACR Compliance Focus  
**Sprint Duration:** Weeks 3-4 (December 6 - December 20, 2025)  
**Total Story Points:** 82

---

## Sprint 2 Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **API Framework** | Express 4.x |
| **Module System** | ES Modules (import/export) |
| **Validation** | Zod schemas |
| **ORM** | Prisma |
| **AI SDK** | @google/generative-ai |
| **PDF Libraries** | pdf-lib, pdfjs-dist |
| **Infrastructure** | AWS (ECS, RDS, ElastiCache, S3) |
| **CI/CD** | GitHub Actions |

**🎯 Key Milestone:** DevOps Engineer joins December 15, 2025. First week focuses on AI integration and PDF processing; second week adds AWS infrastructure deployment.

---

## Epic 2.1: AWS Infrastructure Setup

### Prompt US-2.1.1: AWS RDS PostgreSQL Setup

#### Context
With the DevOps engineer joining mid-sprint, we now provision production-grade PostgreSQL on AWS RDS to replace Replit's development database.

#### Prerequisites
- Sprint 1 complete (Replit development environment working)
- AWS account access configured
- DevOps engineer has joined (Dec 15)

#### Current State
You should have:
- Application running in Replit with local PostgreSQL
- Prisma schema defined and tested
- All Sprint 1 features working

#### Objective
Provision AWS RDS PostgreSQL instance with Multi-AZ deployment, automated backups, and secure credential storage.

#### Technical Requirements

**AWS RDS Configuration:**

```yaml
# Infrastructure specifications
RDS Instance:
  Engine: PostgreSQL 14
  Instance Class: db.t3.medium
  Storage: 100GB gp3
  Multi-AZ: true
  Backup Retention: 7 days
  Encryption: true (AWS managed key)

Security:
  VPC: ninja-vpc
  Subnet Group: ninja-db-subnet-group (private subnets)
  Security Group: ninja-rds-sg
    - Inbound: PostgreSQL (5432) from ECS security group
    - No public access
```

**Create database using Terraform or CloudFormation:**

```hcl
# terraform/rds.tf
resource "aws_db_instance" "ninja_postgres" {
  identifier        = "ninja-production"
  engine            = "postgres"
  engine_version    = "14"
  instance_class    = "db.t3.medium"
  allocated_storage = 100
  storage_type      = "gp3"

  db_name  = "ninja"
  username = "ninja_admin"
  password = aws_secretsmanager_secret_version.db_password.secret_string

  multi_az               = true
  publicly_accessible    = false
  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.ninja.name

  backup_retention_period = 7
  backup_window          = "03:00-04:00"
  maintenance_window     = "Mon:04:00-Mon:05:00"

  storage_encrypted = true

  skip_final_snapshot = false
  final_snapshot_identifier = "ninja-final-snapshot"

  tags = {
    Name        = "ninja-production"
    Environment = "production"
  }
}
```

**Store credentials in AWS Secrets Manager:**

```bash
aws secretsmanager create-secret \
  --name ninja/production/database \
  --secret-string '{"username":"ninja_admin","password":"<generated>","host":"<rds-endpoint>","port":"5432","database":"ninja"}'
```

#### Acceptance Criteria
- [ ] Given AWS account is configured
- [ ] When RDS instance is provisioned
- [ ] Then database is accessible from VPC
- [ ] And Multi-AZ deployment is enabled
- [ ] And automated backups are enabled (7-day retention)
- [ ] And credentials are stored in AWS Secrets Manager

#### Implementation Notes
- Use private subnets only - no public access
- Enable Performance Insights for monitoring
- Configure CloudWatch alarms for CPU, connections, storage

---

### Prompt US-2.1.2: AWS ElastiCache Redis Setup

#### Context
Provisioning Redis on ElastiCache for job queues and caching to replace Replit's Redis.

#### Prerequisites
- US-2.1.1 (RDS PostgreSQL) is complete
- VPC and subnets are configured

#### Current State
You should have:
- RDS PostgreSQL running
- VPC infrastructure in place

#### Objective
Deploy Redis cluster on ElastiCache with replication and automatic failover.

#### Technical Requirements

**ElastiCache Configuration:**

```yaml
ElastiCache Cluster:
  Engine: Redis 7.x
  Node Type: cache.t3.medium
  Replicas: 1 (primary + 1 replica)
  Multi-AZ: true
  Automatic Failover: enabled
  Encryption: In-transit and at-rest

Security:
  Subnet Group: ninja-cache-subnet-group (private subnets)
  Security Group: ninja-redis-sg
    - Inbound: Redis (6379) from ECS security group
```

**Terraform configuration:**

```hcl
# terraform/elasticache.tf
resource "aws_elasticache_replication_group" "ninja_redis" {
  replication_group_id       = "ninja-redis"
  description                = "Redis cluster for Ninja Platform"
  node_type                  = "cache.t3.medium"
  num_cache_clusters         = 2
  port                       = 6379

  engine               = "redis"
  engine_version       = "7.0"
  parameter_group_name = "default.redis7"

  automatic_failover_enabled = true
  multi_az_enabled          = true

  subnet_group_name  = aws_elasticache_subnet_group.ninja.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 7
  snapshot_window         = "05:00-06:00"

  tags = {
    Name        = "ninja-redis"
    Environment = "production"
  }
}
```

#### Acceptance Criteria
- [ ] Given AWS ElastiCache is configured
- [ ] When Redis cluster is provisioned
- [ ] Then it is accessible from ECS cluster
- [ ] And replication is configured (1 primary, 1 replica)
- [ ] And automatic failover is enabled
- [ ] And TLS encryption is enabled

#### Implementation Notes
- Store Redis connection string in Secrets Manager
- Configure CloudWatch alarms for memory usage
- Test failover procedure

---

### Prompt US-2.1.3: ECS Fargate Cluster Setup

#### Context
Setting up AWS ECS Fargate for running the Ninja Platform API as containers.

#### Prerequisites
- US-2.1.1 (RDS PostgreSQL) is complete
- US-2.1.2 (ElastiCache Redis) is complete

#### Current State
You should have:
- Database and Redis running
- Application ready to containerize

#### Objective
Create ECS Fargate cluster with task definitions for the API server.

#### Technical Requirements

**Create Dockerfile for API:**

```dockerfile
# Dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma

# Generate Prisma client
RUN npx prisma generate

USER node
EXPOSE 3000
CMD ["dumb-init", "node", "dist/index.js"]
```

**ECS Task Definition:**

```json
{
  "family": "ninja-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCOUNT:role/ninjaTaskRole",
  "containerDefinitions": [
    {
      "name": "ninja-api",
      "image": "ACCOUNT.dkr.ecr.REGION.amazonaws.com/ninja-api:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "3000"}
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:ninja/production/database-url"
        },
        {
          "name": "REDIS_URL",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:ninja/production/redis-url"
        },
        {
          "name": "JWT_SECRET",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:ninja/production/jwt-secret"
        },
        {
          "name": "GEMINI_API_KEY",
          "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:ninja/production/gemini-api-key"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ninja-api",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/api/v1/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

**ECS Service Configuration:**

```hcl
# terraform/ecs.tf
resource "aws_ecs_service" "ninja_api" {
  name            = "ninja-api"
  cluster         = aws_ecs_cluster.ninja.id
  task_definition = aws_ecs_task_definition.ninja_api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ninja_api.arn
    container_name   = "ninja-api"
    container_port   = 3000
  }

  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
```

#### Acceptance Criteria
- [ ] Given ECS Fargate cluster exists
- [ ] When task definition is deployed
- [ ] Then API runs in containerized environment
- [ ] And auto-scaling is configured (2-10 tasks)
- [ ] And health checks pass
- [ ] And logs stream to CloudWatch

#### Implementation Notes
- Use deployment circuit breaker for automatic rollback
- Configure auto-scaling based on CPU and request count
- Store all secrets in AWS Secrets Manager

---

### Prompt US-2.1.4: S3 Bucket Configuration

#### Context
Setting up S3 for file storage to replace Replit's persistent storage.

#### Prerequisites
- AWS account configured
- IAM roles for ECS tasks

#### Current State
You should have:
- Files stored in Replit persistent storage
- File service working with local storage

#### Objective
Create S3 bucket for document storage with proper access controls and lifecycle policies.

#### Technical Requirements

**S3 Bucket Configuration:**

```hcl
# terraform/s3.tf
resource "aws_s3_bucket" "ninja_files" {
  bucket = "ninja-files-${var.environment}"

  tags = {
    Name        = "ninja-files"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "ninja_files" {
  bucket = aws_s3_bucket.ninja_files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ninja_files" {
  bucket = aws_s3_bucket.ninja_files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "ninja_files" {
  bucket = aws_s3_bucket.ninja_files.id

  rule {
    id     = "cleanup-temp-files"
    status = "Enabled"

    filter {
      prefix = "temp/"
    }

    expiration {
      days = 7
    }
  }

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    filter {
      prefix = "processed/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "ninja_files" {
  bucket = aws_s3_bucket.ninja_files.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://ninja.s4carlisle.com"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}
```

**Update file service for S3:**

```typescript
// src/services/s3.service.ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.S3_BUCKET || 'ninja-files-production';

export class S3Service {
  async uploadFile(key: string, body: Buffer, contentType: string): Promise<string> {
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));

    return `s3://${BUCKET_NAME}/${key}`;
  }

  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
  }

  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
  }

  async deleteFile(key: string): Promise<void> {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
  }
}

export const s3Service = new S3Service();
```

#### Acceptance Criteria
- [ ] Given S3 bucket is created
- [ ] When files are uploaded
- [ ] Then files are stored with server-side encryption
- [ ] And versioning is enabled
- [ ] And lifecycle policies manage storage costs
- [ ] And CORS is configured for frontend uploads

#### Implementation Notes
- Use presigned URLs for direct browser uploads
- Organize files by tenant: `{tenantId}/{year}/{month}/{filename}`
- Enable versioning for recovery capability

---

### Prompt US-2.1.5: Application Load Balancer

#### Context
Setting up ALB to route traffic to ECS services with SSL termination.

#### Prerequisites
- US-2.1.3 (ECS Fargate Cluster) is complete
- SSL certificate in AWS Certificate Manager

#### Current State
You should have:
- ECS service running
- Domain configured (ninja.s4carlisle.com)

#### Objective
Configure Application Load Balancer with HTTPS, health checks, and routing rules.

#### Technical Requirements

**ALB Configuration:**

```hcl
# terraform/alb.tf
resource "aws_lb" "ninja" {
  name               = "ninja-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = true

  tags = {
    Name        = "ninja-alb"
    Environment = var.environment
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.ninja.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.ninja.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ninja_api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.ninja.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_target_group" "ninja_api" {
  name        = "ninja-api-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.ninja.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/api/v1/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}
```

#### Acceptance Criteria
- [ ] Given ALB is configured
- [ ] When requests hit the load balancer
- [ ] Then HTTPS traffic is terminated at ALB
- [ ] And HTTP redirects to HTTPS
- [ ] And health checks monitor ECS tasks
- [ ] And unhealthy targets are removed

#### Implementation Notes
- Use TLS 1.3 security policy
- Configure access logs to S3
- Set up CloudWatch alarms for 5xx errors

---

## Epic 2.2: CI/CD Pipeline

### Prompt US-2.2.1: GitHub Actions CI Workflow

#### Context
Setting up continuous integration with GitHub Actions for automated testing and linting.

#### Prerequisites
- Git repository on GitHub
- Test suite in place

#### Current State
You should have:
- Code in GitHub repository
- Jest tests written

#### Objective
Create GitHub Actions workflow for CI that runs on every pull request.

#### Technical Requirements

**Create `.github/workflows/ci.yml`:**

```yaml
name: CI

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

env:
  NODE_VERSION: '18'

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        run: npm run lint

      - name: Check TypeScript
        run: npm run type-check

  test:
    name: Test
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: ninja_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Generate Prisma client
        run: npx prisma generate

      - name: Run migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/ninja_test

      - name: Run tests
        run: npm test -- --coverage
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/ninja_test
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: test-secret-key-for-ci
          NODE_ENV: test

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: dist
          path: dist/
```

#### Acceptance Criteria
- [ ] Given code is pushed or PR created
- [ ] When CI workflow runs
- [ ] Then linting passes
- [ ] And TypeScript compiles without errors
- [ ] And all tests pass
- [ ] And coverage report is generated

#### Implementation Notes
- Use service containers for database and Redis
- Cache npm dependencies for faster builds
- Fail fast on lint errors

---

### Prompt US-2.2.2: Docker Image Build & Push

#### Context
Setting up automated Docker image building and pushing to AWS ECR.

#### Prerequisites
- US-2.2.1 (CI Workflow) is complete
- AWS ECR repository created

#### Current State
You should have:
- Dockerfile in repository
- CI workflow passing

#### Objective
Extend CI/CD to build Docker images and push to ECR on successful builds.

#### Technical Requirements

**Create `.github/workflows/build-push.yml`:**

```yaml
name: Build and Push

on:
  push:
    branches: [main, develop]
  workflow_dispatch:

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: ninja-api

jobs:
  build-and-push:
    name: Build and Push to ECR
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ steps.login-ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}
          tags: |
            type=ref,event=branch
            type=sha,prefix={{branch}}-
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Output image digest
        run: echo "Image pushed with digest ${{ steps.docker_build.outputs.digest }}"
```

**Create ECR repository:**

```bash
aws ecr create-repository \
  --repository-name ninja-api \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

#### Acceptance Criteria
- [ ] Given code is pushed to main/develop
- [ ] When build workflow runs
- [ ] Then Docker image is built
- [ ] And image is pushed to ECR
- [ ] And image is tagged with branch and SHA
- [ ] And image scanning is enabled

#### Implementation Notes
- Use OIDC for AWS authentication (no access keys)
- Enable build cache for faster builds
- Scan images for vulnerabilities

---

### Prompt US-2.2.3: Staging Deployment Pipeline

#### Context
Creating automated deployment to staging environment on successful builds.

#### Prerequisites
- US-2.2.2 (Docker Build & Push) is complete
- US-2.1.3 (ECS Cluster) is complete

#### Current State
You should have:
- Docker images in ECR
- ECS cluster running

#### Objective
Automate deployment to staging environment with rolling updates.

#### Technical Requirements

**Create `.github/workflows/deploy-staging.yml`:**

```yaml
name: Deploy to Staging

on:
  push:
    branches: [develop]
  workflow_dispatch:

env:
  AWS_REGION: us-east-1
  ECS_CLUSTER: ninja-staging
  ECS_SERVICE: ninja-api
  ECR_REPOSITORY: ninja-api

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Get image tag
        id: image-tag
        run: echo "tag=develop-$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT

      - name: Download task definition
        run: |
          aws ecs describe-task-definition \
            --task-definition ninja-api-staging \
            --query taskDefinition > task-definition.json

      - name: Update task definition with new image
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: ninja-api
          image: ${{ steps.login-ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ steps.image-tag.outputs.tag }}

      - name: Deploy to ECS
        uses: aws-actions/amazon-ecs-deploy-action@v1
        with:
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          wait-for-service-stability: true
          wait-for-minutes: 10

      - name: Notify deployment
        if: success()
        run: |
          echo "✅ Deployed to staging: https://staging.ninja.s4carlisle.com"
```

#### Acceptance Criteria
- [ ] Given develop branch is updated
- [ ] When deployment workflow runs
- [ ] Then new image is deployed to staging ECS
- [ ] And rolling update ensures zero downtime
- [ ] And workflow waits for service stability
- [ ] And staging URL is accessible

#### Implementation Notes
- Use GitHub Environments for approval gates
- Wait for service stability before completing
- Add Slack notification for deployment status

---

### Prompt US-2.2.4: Production Deployment Pipeline

#### Context
Creating production deployment with manual approval and blue-green deployment strategy.

#### Prerequisites
- US-2.2.3 (Staging Deployment) is complete

#### Current State
You should have:
- Staging deployment working
- Production ECS cluster ready

#### Objective
Create production deployment workflow with manual approval and rollback capability.

#### Technical Requirements

**Create `.github/workflows/deploy-production.yml`:**

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Docker image tag to deploy'
        required: true
        default: 'latest'

env:
  AWS_REGION: us-east-1
  ECS_CLUSTER: ninja-production
  ECS_SERVICE: ninja-api
  ECR_REPOSITORY: ninja-api

jobs:
  approve:
    name: Request Approval
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Approval gate
        run: echo "Deployment approved"

  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: approve
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Determine image tag
        id: image-tag
        run: |
          if [ "${{ github.event.inputs.image_tag }}" != "" ]; then
            echo "tag=${{ github.event.inputs.image_tag }}" >> $GITHUB_OUTPUT
          else
            echo "tag=main-$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT
          fi

      - name: Create deployment record
        run: |
          echo "Deploying ${{ steps.image-tag.outputs.tag }} at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> deployments.log

      - name: Download task definition
        run: |
          aws ecs describe-task-definition \
            --task-definition ninja-api-production \
            --query taskDefinition > task-definition.json

      - name: Update task definition
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: ninja-api
          image: ${{ steps.login-ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ steps.image-tag.outputs.tag }}

      - name: Deploy to ECS (Blue-Green)
        uses: aws-actions/amazon-ecs-deploy-action@v1
        with:
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Run smoke tests
        run: |
          sleep 30
          curl -f https://ninja.s4carlisle.com/api/v1/health || exit 1
          echo "✅ Health check passed"

      - name: Tag release
        if: success()
        run: |
          git tag "release-$(date +%Y%m%d-%H%M%S)"
          git push origin --tags

  rollback:
    name: Rollback on Failure
    runs-on: ubuntu-latest
    needs: deploy
    if: failure()
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Rollback to previous task definition
        run: |
          PREVIOUS_TASK=$(aws ecs describe-services \
            --cluster ${{ env.ECS_CLUSTER }} \
            --services ${{ env.ECS_SERVICE }} \
            --query 'services[0].deployments[1].taskDefinition' \
            --output text)

          aws ecs update-service \
            --cluster ${{ env.ECS_CLUSTER }} \
            --service ${{ env.ECS_SERVICE }} \
            --task-definition $PREVIOUS_TASK

          echo "⚠️ Rolled back to $PREVIOUS_TASK"
```

#### Acceptance Criteria
- [ ] Given staging deployment succeeds
- [ ] When production deployment is triggered
- [ ] Then manual approval is required via GitHub
- [ ] And deployment uses blue-green strategy
- [ ] And rollback is automatic on health check failure
- [ ] And release is tagged on success

#### Implementation Notes
- Require 2 approvers for production
- Run smoke tests after deployment
- Keep deployment history for auditing

---

## Epic 2.3: Google Gemini AI Integration

### Prompt US-2.3.1: Gemini API Client

#### Context
Integrating Google Gemini API for AI-powered document analysis and accessibility checking.

#### Prerequisites
- Sprint 1 complete
- Google Cloud API credentials

#### Current State
You should have:
- Express server running
- Job processing framework

#### Objective
Create Gemini API client with text and vision analysis capabilities.

#### Technical Requirements

**Install dependencies:**

```bash
npm install @google/generative-ai
```

**Create `src/services/ai/gemini.service.ts`:**

```typescript
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export class GeminiService {
  private textModel = genAI.getGenerativeModel({ 
    model: 'gemini-pro',
    safetySettings,
  });

  private visionModel = genAI.getGenerativeModel({ 
    model: 'gemini-pro-vision',
    safetySettings,
  });

  async generateText(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; tokensUsed: number }> {
    const result = await this.textModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options?.maxTokens || 2048,
        temperature: options?.temperature || 0.7,
      },
    });

    const response = result.response;
    const text = response.text();
    const tokensUsed = response.usageMetadata?.totalTokenCount || 0;

    return { text, tokensUsed };
  }

  async analyzeImage(
    imageBuffer: Buffer,
    mimeType: string,
    prompt: string
  ): Promise<{ text: string; tokensUsed: number }> {
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    const result = await this.visionModel.generateContent([prompt, imagePart]);
    const response = result.response;
    const text = response.text();
    const tokensUsed = response.usageMetadata?.totalTokenCount || 0;

    return { text, tokensUsed };
  }

  async generateStructuredOutput<T>(
    prompt: string,
    schema: string
  ): Promise<{ data: T; tokensUsed: number }> {
    const structuredPrompt = `${prompt}

Respond with valid JSON matching this schema:
${schema}

Your entire response must be valid JSON. Do not include any text outside the JSON object.`;

    const { text, tokensUsed } = await this.generateText(structuredPrompt, {
      temperature: 0.3, // Lower temperature for structured output
    });

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse structured response');
    }

    const data = JSON.parse(jsonMatch[0]) as T;
    return { data, tokensUsed };
  }

  async countTokens(text: string): Promise<number> {
    const result = await this.textModel.countTokens(text);
    return result.totalTokens;
  }
}

export const geminiService = new GeminiService();
```

**Create retry wrapper:**

```typescript
// src/utils/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000 } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) break;

      // Check if error is retryable
      const isRetryable = 
        error instanceof Error &&
        (error.message.includes('429') || // Rate limit
         error.message.includes('503') || // Service unavailable
         error.message.includes('timeout'));

      if (!isRetryable) throw error;

      // Exponential backoff
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
```

#### Acceptance Criteria
- [ ] Given Gemini API credentials are configured
- [ ] When client is initialized
- [ ] Then text generation (gemini-pro) is supported
- [ ] And vision analysis (gemini-pro-vision) is supported
- [ ] And token counting is available
- [ ] And retry logic handles transient failures

#### Implementation Notes
- Use exponential backoff for rate limit errors
- Log all API calls with token counts for cost tracking
- Disable safety filters for document analysis

---

### Prompt US-2.3.2: Token Counting & Cost Estimation

#### Context
Implementing token counting and cost estimation for AI operations.

#### Prerequisites
- US-2.3.1 (Gemini API Client) is complete

#### Current State
You should have:
- Gemini service working
- Text and vision analysis available

#### Objective
Create cost estimation service that calculates token usage before job submission.

#### Technical Requirements

**Create `src/services/ai/cost-estimator.service.ts`:**

```typescript
import { geminiService } from './gemini.service.js';

// Pricing per 1K tokens (approximate INR rates)
const PRICING = {
  'gemini-pro': {
    input: 0.05,   // ₹0.05 per 1K input tokens
    output: 0.15,  // ₹0.15 per 1K output tokens
  },
  'gemini-pro-vision': {
    input: 0.10,   // ₹0.10 per 1K input tokens (includes image)
    output: 0.20,  // ₹0.20 per 1K output tokens
  },
};

interface CostEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostInr: number;
  model: string;
  confidence: 'high' | 'medium' | 'low';
}

export class CostEstimatorService {
  async estimateTextAnalysis(text: string): Promise<CostEstimate> {
    const inputTokens = await geminiService.countTokens(text);

    // Estimate output tokens based on typical response ratios
    const estimatedOutputTokens = Math.ceil(inputTokens * 0.3);

    const inputCost = (inputTokens / 1000) * PRICING['gemini-pro'].input;
    const outputCost = (estimatedOutputTokens / 1000) * PRICING['gemini-pro'].output;

    return {
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens,
      estimatedCostInr: Math.round((inputCost + outputCost) * 100) / 100,
      model: 'gemini-pro',
      confidence: 'high',
    };
  }

  async estimateImageAnalysis(
    imageSize: number,
    textContext?: string
  ): Promise<CostEstimate> {
    // Approximate tokens for image based on size
    const imageTokens = Math.ceil(imageSize / 1000); // ~1 token per KB

    let contextTokens = 0;
    if (textContext) {
      contextTokens = await geminiService.countTokens(textContext);
    }

    const inputTokens = imageTokens + contextTokens + 100; // +100 for prompt
    const estimatedOutputTokens = 200; // Typical alt text length

    const inputCost = (inputTokens / 1000) * PRICING['gemini-pro-vision'].input;
    const outputCost = (estimatedOutputTokens / 1000) * PRICING['gemini-pro-vision'].output;

    return {
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens,
      estimatedCostInr: Math.round((inputCost + outputCost) * 100) / 100,
      model: 'gemini-pro-vision',
      confidence: 'medium',
    };
  }

  async estimatePdfAnalysis(
    pageCount: number,
    hasImages: boolean
  ): Promise<CostEstimate> {
    // Estimate based on typical PDF content
    const tokensPerPage = 500;
    const textTokens = pageCount * tokensPerPage;

    let imageTokens = 0;
    if (hasImages) {
      // Assume average of 2 images per page, 1000 tokens each
      imageTokens = pageCount * 2 * 1000;
    }

    const inputTokens = textTokens + imageTokens;
    const estimatedOutputTokens = pageCount * 100; // 100 tokens per page for analysis

    const textCost = (textTokens / 1000) * PRICING['gemini-pro'].input +
                     (estimatedOutputTokens / 1000) * PRICING['gemini-pro'].output;

    const imageCost = hasImages
      ? (imageTokens / 1000) * PRICING['gemini-pro-vision'].input
      : 0;

    return {
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens,
      estimatedCostInr: Math.round((textCost + imageCost) * 100) / 100,
      model: 'mixed',
      confidence: 'low',
    };
  }
}

export const costEstimatorService = new CostEstimatorService();
```

**Add endpoint for cost estimation:**

```typescript
// In jobs.routes.ts
router.post('/estimate', validate(estimateJobSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { type, fileId } = req.body;
    const file = await fileService.getFile(fileId, req.user!.tenantId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    let estimate;
    if (type === 'PDF_ACCESSIBILITY') {
      // Get page count from file metadata
      const pageCount = (file.metadata as any)?.pageCount || 10;
      const hasImages = (file.metadata as any)?.hasImages || true;
      estimate = await costEstimatorService.estimatePdfAnalysis(pageCount, hasImages);
    } else {
      estimate = await costEstimatorService.estimateTextAnalysis('sample text');
    }

    res.json(estimate);
  } catch (error) {
    next(error);
  }
});
```

#### Acceptance Criteria
- [ ] Given a file is uploaded
- [ ] When cost estimation is requested
- [ ] Then tokens are estimated based on content
- [ ] And cost is calculated in INR
- [ ] And estimate shows ±5% accuracy
- [ ] And estimation completes in < 2 seconds

#### Implementation Notes
- Cache estimates for same file
- Update pricing when Gemini rates change
- Track actual vs estimated for accuracy improvement

---

### Prompt US-2.3.3: AI Response Parsing

#### Context
Creating robust parsing for AI-generated responses with validation.

#### Prerequisites
- US-2.3.1 (Gemini API Client) is complete

#### Current State
You should have:
- Gemini service generating responses
- Need structured data extraction

#### Objective
Create response parser that extracts and validates structured data from AI responses.

#### Technical Requirements

**Create `src/services/ai/response-parser.service.ts`:**

```typescript
import { z } from 'zod';

// Schema for accessibility issue
const accessibilityIssueSchema = z.object({
  criterion: z.string(),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  title: z.string(),
  description: z.string(),
  location: z.object({
    page: z.number().optional(),
    element: z.string().optional(),
  }).optional(),
  remediation: z.string(),
});

// Schema for alt text suggestion
const altTextSchema = z.object({
  altText: z.string(),
  longDescription: z.string().optional(),
  confidence: z.number().min(0).max(1),
  imageType: z.enum(['photo', 'diagram', 'chart', 'screenshot', 'logo', 'decorative']),
});

// Schema for document analysis
const documentAnalysisSchema = z.object({
  summary: z.string(),
  issues: z.array(accessibilityIssueSchema),
  overallScore: z.number().min(0).max(100),
  recommendations: z.array(z.string()),
});

export class ResponseParserService {
  parseAccessibilityIssues(response: string): z.infer<typeof accessibilityIssueSchema>[] {
    const cleaned = this.cleanJsonResponse(response);
    const parsed = JSON.parse(cleaned);

    // Handle both array and object with issues property
    const issues = Array.isArray(parsed) ? parsed : parsed.issues;

    return z.array(accessibilityIssueSchema).parse(issues);
  }

  parseAltText(response: string): z.infer<typeof altTextSchema> {
    const cleaned = this.cleanJsonResponse(response);
    const parsed = JSON.parse(cleaned);

    return altTextSchema.parse(parsed);
  }

  parseDocumentAnalysis(response: string): z.infer<typeof documentAnalysisSchema> {
    const cleaned = this.cleanJsonResponse(response);
    const parsed = JSON.parse(cleaned);

    return documentAnalysisSchema.parse(parsed);
  }

  private cleanJsonResponse(response: string): string {
    // Remove markdown code blocks
    let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    // Remove leading/trailing whitespace
    cleaned = cleaned.trim();

    // Find JSON object or array
    const jsonMatch = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in response');
    }

    return jsonMatch[0];
  }

  sanitizeText(text: string): string {
    // Remove potential prompt injection attempts
    return text
      .replace(/ignore previous instructions/gi, '')
      .replace(/disregard/gi, '')
      .replace(/system:/gi, '')
      .trim();
  }
}

export const responseParserService = new ResponseParserService();
```

#### Acceptance Criteria
- [ ] Given an AI response is received
- [ ] When parsing is attempted
- [ ] Then structured data (JSON) is extracted
- [ ] And response is validated against expected schema
- [ ] And malformed responses are handled gracefully
- [ ] And potential injection attempts are sanitized

#### Implementation Notes
- Use Zod for runtime validation
- Handle markdown code blocks in responses
- Log parsing failures for debugging

---

## Epic 2.4: PDF Processing Foundation

### Prompt US-2.4.1: PDF Parsing Service

#### Context
Creating the foundational PDF parsing service for document analysis.

#### Prerequisites
- Sprint 1 file upload working
- Node.js environment configured

#### Current State
You should have:
- Files uploaded to storage
- Job processing framework

#### Objective
Create PDF parsing service that extracts metadata and structure from PDF documents.

#### Technical Requirements

**Install dependencies:**

```bash
npm install pdf-lib pdfjs-dist
npm install -D @types/pdfjs-dist
```

**Create `src/services/pdf/pdf-parser.service.ts`:**

```typescript
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/build/pdf.worker.js';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  pageCount: number;
  pdfVersion: string;
  isTagged: boolean;
  hasOutlines: boolean;
  hasAcroForm: boolean;
  isEncrypted: boolean;
  permissions?: {
    printing: boolean;
    copying: boolean;
    modifying: boolean;
  };
}

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  hasText: boolean;
  hasImages: boolean;
}

export class PdfParserService {
  async parseMetadata(filePath: string): Promise<PdfMetadata> {
    const fileBuffer = await fs.readFile(filePath);

    // Use pdf-lib for basic metadata
    const pdfDoc = await PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
    });

    const { title, author, subject, keywords, creator, producer, creationDate, modificationDate } = pdfDoc;

    // Use pdfjs-dist for additional info
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata();

    // Check for tagging
    const markInfo = metadata.info?.MarkInfo;
    const isTagged = markInfo?.Marked === true;

    // Check for outlines (bookmarks)
    const outline = await pdf.getOutline();
    const hasOutlines = outline !== null && outline.length > 0;

    return {
      title: title || metadata.info?.Title,
      author: author || metadata.info?.Author,
      subject: subject || metadata.info?.Subject,
      keywords: keywords ? keywords.split(',').map(k => k.trim()) : [],
      creator: creator || metadata.info?.Creator,
      producer: producer || metadata.info?.Producer,
      creationDate: creationDate ? new Date(creationDate) : undefined,
      modificationDate: modificationDate ? new Date(modificationDate) : undefined,
      pageCount: pdf.numPages,
      pdfVersion: metadata.info?.PDFFormatVersion || 'unknown',
      isTagged,
      hasOutlines,
      hasAcroForm: false, // Would need additional check
      isEncrypted: pdfDoc.isEncrypted,
    };
  }

  async getPageInfo(filePath: string): Promise<PdfPage[]> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    const pages: PdfPage[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });

      // Check for text content
      const textContent = await page.getTextContent();
      const hasText = textContent.items.length > 0;

      // Check for images (operators)
      const ops = await page.getOperatorList();
      const hasImages = ops.fnArray.some(fn => 
        fn === pdfjsLib.OPS.paintImageXObject ||
        fn === pdfjsLib.OPS.paintInlineImageXObject
      );

      pages.push({
        pageNumber: i,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        hasText,
        hasImages,
      });
    }

    return pages;
  }

  async validate(filePath: string): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const fileBuffer = await fs.readFile(filePath);

      // Check file signature
      const header = fileBuffer.slice(0, 5).toString();
      if (!header.startsWith('%PDF-')) {
        errors.push('Invalid PDF file signature');
        return { isValid: false, errors };
      }

      // Try to load with pdf-lib
      await PDFDocument.load(fileBuffer);

      // Try to load with pdfjs-dist
      const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
      await loadingTask.promise;

      return { isValid: true, errors: [] };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error');
      return { isValid: false, errors };
    }
  }
}

export const pdfParserService = new PdfParserService();
```

#### Acceptance Criteria
- [ ] Given a PDF file is uploaded
- [ ] When parsing is requested
- [ ] Then page count, dimensions, metadata are extracted
- [ ] And PDF version and embedded fonts are identified
- [ ] And tagged/untagged status is detected
- [ ] And corrupt PDFs return descriptive errors

#### Implementation Notes
- Use pdf-lib for modification capabilities
- Use pdfjs-dist for rendering and text extraction
- Handle password-protected PDFs gracefully
- Set timeout of 60 seconds for large files

---

### Prompt US-2.4.2: Text Extraction Service

#### Context
Extracting text content from PDFs while preserving reading order.

#### Prerequisites
- US-2.4.1 (PDF Parsing Service) is complete

#### Current State
You should have:
- PDF parser extracting metadata
- pdfjs-dist configured

#### Objective
Create text extraction service that maintains reading order and handles multi-column layouts.

#### Technical Requirements

**Create `src/services/pdf/text-extractor.service.ts`:**

```typescript
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';

export interface TextBlock {
  text: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  fontName?: string;
}

export interface PageText {
  pageNumber: number;
  text: string;
  blocks: TextBlock[];
}

export class TextExtractorService {
  async extractText(filePath: string): Promise<PageText[]> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    const pages: PageText[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });

      const blocks: TextBlock[] = [];
      let pageText = '';

      for (const item of textContent.items) {
        if ('str' in item) {
          const transform = item.transform;
          const x = transform[4];
          const y = viewport.height - transform[5]; // Flip Y coordinate

          blocks.push({
            text: item.str,
            pageNumber: i,
            x,
            y,
            width: item.width,
            height: item.height,
            fontName: item.fontName,
          });

          pageText += item.str;

          // Add space or newline based on position
          if (item.hasEOL) {
            pageText += '\n';
          } else {
            pageText += ' ';
          }
        }
      }

      // Sort blocks by reading order (top-to-bottom, left-to-right)
      blocks.sort((a, b) => {
        const yDiff = a.y - b.y;
        if (Math.abs(yDiff) > 10) return yDiff; // Different line
        return a.x - b.x; // Same line, sort by x
      });

      pages.push({
        pageNumber: i,
        text: pageText.trim(),
        blocks,
      });
    }

    return pages;
  }

  async extractTextByPage(filePath: string, pageNumber: number): Promise<PageText> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`Page ${pageNumber} out of range (1-${pdf.numPages})`);
    }

    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();

    const blocks: TextBlock[] = [];
    let pageText = '';

    for (const item of textContent.items) {
      if ('str' in item) {
        blocks.push({
          text: item.str,
          pageNumber,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height,
        });
        pageText += item.str + ' ';
      }
    }

    return {
      pageNumber,
      text: pageText.trim(),
      blocks,
    };
  }

  async getFullText(filePath: string): Promise<string> {
    const pages = await this.extractText(filePath);
    return pages.map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
  }
}

export const textExtractorService = new TextExtractorService();
```

#### Acceptance Criteria
- [ ] Given a PDF is parsed
- [ ] When text extraction runs
- [ ] Then all visible text is extracted
- [ ] And reading order is preserved
- [ ] And page numbers are included
- [ ] And multi-column layouts are handled

#### Implementation Notes
- Sort text blocks by position for correct reading order
- Handle RTL languages if needed
- Preserve paragraph structure where possible

---

### Prompt US-2.4.3: Image Extraction Service

#### Context
Extracting images from PDFs for accessibility analysis and alt text generation.

#### Prerequisites
- US-2.4.1 (PDF Parsing Service) is complete

#### Current State
You should have:
- PDF parser working
- File storage configured

#### Objective
Create image extraction service that extracts all images from PDF documents.

#### Technical Requirements

**Create `src/services/pdf/image-extractor.service.ts`:**

```typescript
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

export interface ExtractedImage {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mimeType: string;
  buffer: Buffer;
  filePath?: string;
}

export class ImageExtractorService {
  async extractImages(
    filePath: string,
    outputDir?: string
  ): Promise<ExtractedImage[]> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    const images: ExtractedImage[] = [];
    let imageIndex = 0;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();
      const commonObjs = page.commonObjs;
      const objs = page.objs;

      for (let j = 0; j < ops.fnArray.length; j++) {
        const fn = ops.fnArray[j];

        if (fn === pdfjsLib.OPS.paintImageXObject ||
            fn === pdfjsLib.OPS.paintInlineImageXObject) {
          try {
            const imgName = ops.argsArray[j][0];
            const imgData = await this.getImageData(objs, commonObjs, imgName);

            if (imgData) {
              imageIndex++;
              const id = `img-${i}-${imageIndex}`;

              // Convert to PNG using sharp
              const buffer = await this.convertToPng(imgData);

              const image: ExtractedImage = {
                id,
                pageNumber: i,
                x: 0, // Would need transform matrix for accurate position
                y: 0,
                width: imgData.width,
                height: imgData.height,
                mimeType: 'image/png',
                buffer,
              };

              // Save to file if output directory provided
              if (outputDir) {
                const fileName = `${id}.png`;
                const imagePath = path.join(outputDir, fileName);
                await fs.writeFile(imagePath, buffer);
                image.filePath = imagePath;
              }

              images.push(image);
            }
          } catch (error) {
            console.error(`Error extracting image on page ${i}:`, error);
          }
        }
      }
    }

    return images;
  }

  private async getImageData(
    objs: any,
    commonObjs: any,
    imgName: string
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
    return new Promise((resolve) => {
      const resolveData = (data: any) => {
        if (data && data.bitmap) {
          resolve({
            data: data.bitmap.data,
            width: data.bitmap.width,
            height: data.bitmap.height,
          });
        } else if (data && data.data) {
          resolve({
            data: data.data,
            width: data.width,
            height: data.height,
          });
        } else {
          resolve(null);
        }
      };

      // Try objs first, then commonObjs
      objs.get(imgName, resolveData);
      setTimeout(() => {
        commonObjs.get(imgName, resolveData);
      }, 100);

      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);
    });
  }

  private async convertToPng(imgData: {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }): Promise<Buffer> {
    // Create raw image buffer
    const buffer = Buffer.from(imgData.data);

    // Use sharp to convert to PNG
    return sharp(buffer, {
      raw: {
        width: imgData.width,
        height: imgData.height,
        channels: 4, // RGBA
      },
    })
      .png()
      .toBuffer();
  }

  async getImageCount(filePath: string): Promise<number> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    let count = 0;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();

      count += ops.fnArray.filter(fn =>
        fn === pdfjsLib.OPS.paintImageXObject ||
        fn === pdfjsLib.OPS.paintInlineImageXObject
      ).length;
    }

    return count;
  }
}

export const imageExtractorService = new ImageExtractorService();
```

**Install sharp:**

```bash
npm install sharp
```

#### Acceptance Criteria
- [ ] Given a PDF contains images
- [ ] When image extraction runs
- [ ] Then all embedded images are extracted
- [ ] And images are converted to PNG format
- [ ] And image dimensions and positions are captured
- [ ] And images can be saved to specified directory

#### Implementation Notes
- Use sharp for image conversion (faster than alternatives)
- Handle various image formats (JPEG, PNG, JBIG2)
- Track memory usage for large PDFs with many images

---

### Prompt US-2.4.4: PDF Structure Analysis

#### Context
Analyzing PDF structure including heading hierarchy, tables, and document organization.

#### Prerequisites
- US-2.4.1 (PDF Parsing Service) is complete
- US-2.4.2 (Text Extraction) is complete

#### Current State
You should have:
- PDF parsing working
- Text extraction functional

#### Objective
Create structure analysis service that identifies document structure elements.

#### Technical Requirements

**Create `src/services/pdf/structure-analyzer.service.ts`:**

```typescript
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';

export interface HeadingInfo {
  level: number; // 1-6
  text: string;
  pageNumber: number;
  position: { x: number; y: number };
}

export interface TableInfo {
  pageNumber: number;
  rowCount: number;
  columnCount: number;
  hasHeaders: boolean;
  position: { x: number; y: number; width: number; height: number };
}

export interface ListInfo {
  pageNumber: number;
  type: 'ordered' | 'unordered';
  itemCount: number;
  position: { x: number; y: number };
}

export interface DocumentStructure {
  headings: HeadingInfo[];
  tables: TableInfo[];
  lists: ListInfo[];
  hasTableOfContents: boolean;
  readingOrder: 'logical' | 'visual' | 'unknown';
  languageTag?: string;
  structureTree?: StructureElement[];
}

export interface StructureElement {
  type: string; // 'P', 'H1', 'Table', 'L', etc.
  children?: StructureElement[];
  text?: string;
  pageNumber?: number;
}

export class StructureAnalyzerService {
  async analyzeStructure(filePath: string): Promise<DocumentStructure> {
    const fileBuffer = await fs.readFile(filePath);
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;

    const metadata = await pdf.getMetadata();
    const outline = await pdf.getOutline();

    // Analyze headings based on font size
    const headings = await this.detectHeadings(pdf);

    // Detect tables (heuristic based on text alignment)
    const tables = await this.detectTables(pdf);

    // Detect lists
    const lists = await this.detectLists(pdf);

    // Check for TOC
    const hasTableOfContents = outline !== null && outline.length > 0;

    // Get language tag
    const languageTag = metadata.info?.Lang;

    // Analyze structure tree if tagged PDF
    let structureTree: StructureElement[] | undefined;
    const markInfo = metadata.info?.MarkInfo;
    if (markInfo?.Marked) {
      structureTree = await this.parseStructureTree(pdf);
    }

    return {
      headings,
      tables,
      lists,
      hasTableOfContents,
      readingOrder: structureTree ? 'logical' : 'visual',
      languageTag,
      structureTree,
    };
  }

  private async detectHeadings(pdf: pdfjsLib.PDFDocumentProxy): Promise<HeadingInfo[]> {
    const headings: HeadingInfo[] = [];
    const fontSizes: number[] = [];

    // First pass: collect all font sizes
    for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if ('transform' in item && item.transform) {
          const fontSize = Math.abs(item.transform[0]); // Scale from transform
          if (fontSize > 0) fontSizes.push(fontSize);
        }
      }
    }

    // Calculate percentiles for heading detection
    fontSizes.sort((a, b) => b - a);
    const p90 = fontSizes[Math.floor(fontSizes.length * 0.1)] || 12;
    const p75 = fontSizes[Math.floor(fontSizes.length * 0.25)] || 11;

    // Second pass: identify headings
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });

      for (const item of textContent.items) {
        if ('str' in item && 'transform' in item) {
          const fontSize = Math.abs(item.transform[0]);
          const text = item.str.trim();

          if (text.length > 0 && text.length < 200) { // Heading shouldn't be too long
            let level = 0;

            if (fontSize >= p90 * 1.5) level = 1;
            else if (fontSize >= p90) level = 2;
            else if (fontSize >= p75 * 1.2) level = 3;
            else if (fontSize >= p75) level = 4;

            if (level > 0) {
              headings.push({
                level,
                text,
                pageNumber: i,
                position: {
                  x: item.transform[4],
                  y: viewport.height - item.transform[5],
                },
              });
            }
          }
        }
      }
    }

    return headings;
  }

  private async detectTables(pdf: pdfjsLib.PDFDocumentProxy): Promise<TableInfo[]> {
    // Simplified table detection - would need more sophisticated algorithm
    // for production use
    const tables: TableInfo[] = [];

    // Placeholder - real implementation would analyze text alignment,
    // spacing patterns, and graphical elements

    return tables;
  }

  private async detectLists(pdf: pdfjsLib.PDFDocumentProxy): Promise<ListInfo[]> {
    const lists: ListInfo[] = [];
    const bulletPatterns = /^[\u2022\u2023\u25E6\u2043\u2219•◦‣⁃○●]\s/;
    const numberPatterns = /^(\d+[\.\)]\s|[a-z][\.\)]\s|[ivxlcdm]+[\.\)]\s)/i;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });

      let currentList: { type: 'ordered' | 'unordered'; items: number; y: number } | null = null;

      for (const item of textContent.items) {
        if ('str' in item) {
          const text = item.str.trim();
          const y = viewport.height - item.transform[5];

          const isBullet = bulletPatterns.test(text);
          const isNumbered = numberPatterns.test(text);

          if (isBullet || isNumbered) {
            const type = isBullet ? 'unordered' : 'ordered';

            if (currentList && currentList.type === type && Math.abs(y - currentList.y) < 50) {
              currentList.items++;
              currentList.y = y;
            } else {
              if (currentList && currentList.items >= 2) {
                lists.push({
                  pageNumber: i,
                  type: currentList.type,
                  itemCount: currentList.items,
                  position: { x: item.transform[4], y },
                });
              }
              currentList = { type, items: 1, y };
            }
          }
        }
      }

      // Add last list on page
      if (currentList && currentList.items >= 2) {
        lists.push({
          pageNumber: i,
          type: currentList.type,
          itemCount: currentList.items,
          position: { x: 0, y: currentList.y },
        });
      }
    }

    return lists;
  }

  private async parseStructureTree(pdf: pdfjsLib.PDFDocumentProxy): Promise<StructureElement[]> {
    // Tagged PDF structure tree parsing
    // This is a placeholder - real implementation would use PDF structure tree API
    return [];
  }
}

export const structureAnalyzerService = new StructureAnalyzerService();
```

#### Acceptance Criteria
- [ ] Given a PDF is parsed
- [ ] When structure analysis runs
- [ ] Then heading hierarchy is extracted (H1-H6)
- [ ] And table structures are identified
- [ ] And list structures are detected
- [ ] And reading order is determined

#### Implementation Notes
- Use font size heuristics for heading detection
- Parse structure tree for tagged PDFs
- Handle both tagged and untagged documents

---

## Sprint 2 Execution Checklist

Execute prompts in this order:

### Week 1 (Dec 6-12) - AI & PDF Processing
- [ ] US-2.3.1: Gemini API Client
- [ ] US-2.3.2: Token Counting & Cost Estimation
- [ ] US-2.3.3: AI Response Parsing
- [ ] US-2.4.1: PDF Parsing Service
- [ ] US-2.4.2: Text Extraction Service
- [ ] US-2.4.3: Image Extraction Service
- [ ] US-2.4.4: PDF Structure Analysis

### Week 2 (Dec 13-20) - AWS & CI/CD (DevOps joins Dec 15)
- [ ] US-2.1.1: AWS RDS PostgreSQL Setup
- [ ] US-2.1.2: AWS ElastiCache Redis Setup
- [ ] US-2.1.3: ECS Fargate Cluster Setup
- [ ] US-2.1.4: S3 Bucket Configuration
- [ ] US-2.1.5: Application Load Balancer
- [ ] US-2.2.1: GitHub Actions CI Workflow
- [ ] US-2.2.2: Docker Image Build & Push
- [ ] US-2.2.3: Staging Deployment Pipeline
- [ ] US-2.2.4: Production Deployment Pipeline

---

## Sprint 2 Success Criteria

- ✅ AWS infrastructure fully operational (RDS, ElastiCache, ECS, S3)
- ✅ CI/CD pipeline deploying automatically to staging
- ✅ Gemini AI integration working with cost tracking
- ✅ PDF processing extracting text, images, and structure
- ✅ Migration from Replit to AWS complete

---

*End of Sprint 2 Replit Prompts*
