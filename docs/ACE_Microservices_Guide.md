# AWS Infrastructure Guide
## ACE Microservice - Staging Environment

**Document:** AWS Infrastructure Guide - ACE Microservice
**Environment:** Non-Production (Staging)
**AWS Account:** 223643972423
**Region:** ap-south-1 (Mumbai)
**Last Updated:** December 24, 2025

---

## 1. Service Overview

The ACE (Accessibility Checker for EPUB) Microservice provides EPUB accessibility auditing capabilities via a REST API. It runs DAISY ACE in a Docker container with all required Electron/GUI dependencies.

### 1.1 Why a Separate Microservice?

ACE requires Electron, which needs GUI dependencies (X11, GTK3, Xvfb, etc.) that aren't available in cloud environments like Replit. This microservice packages ACE with all dependencies in a Docker container deployed to AWS ECS.

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     AWS Infrastructure                          │
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌──────────────────┐   │
│  │   Ninja     │    │    ALB      │    │   ECS Fargate    │   │
│  │  Backend    │───▶│  /ace/*     │───▶│  ACE Container   │   │
│  │  (Replit)   │    │             │    │                  │   │
│  └─────────────┘    └─────────────┘    └──────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Container Infrastructure

### 2.1 ECR Repository

| Setting | Value |
|---------|-------|
| Repository Name | `ace-microservice` |
| Repository URI | `223643972423.dkr.ecr.ap-south-1.amazonaws.com/ace-microservice` |
| Repository ARN | `arn:aws:ecr:ap-south-1:223643972423:repository/ace-microservice` |
| Image Tag Mutability | Mutable |
| Encryption | AES-256 |
| Scan on Push | Disabled |

### 2.2 ECS Cluster

| Setting | Value |
|---------|-------|
| Cluster Name | `ninja-cluster` |
| Cluster ARN | `arn:aws:ecs:ap-south-1:223643972423:cluster/ninja-cluster` |
| Capacity Provider | FARGATE, FARGATE_SPOT |

### 2.3 Task Definition

| Setting | Value |
|---------|-------|
| Family | `ace-microservice-task` |
| Revision | 1 |
| Launch Type | AWS Fargate |
| CPU | 1 vCPU (1024 units) |
| Memory | 2 GB (2048 MB) |
| Container Name | `ace-microservice` |
| Container Port | 3001 |
| Task Execution Role | `ecsTaskExecutionRole` |
| Network Mode | awsvpc |

#### Environment Variables

| Variable | Type | Value |
|----------|------|-------|
| NODE_ENV | Plain text | production |
| PORT | Plain text | 3001 |

#### Container Health Check

| Setting | Value |
|---------|-------|
| Command | `wget --no-verbose --tries=1 --spider http://localhost:3001/health \|\| exit 1` |
| Interval | 30 seconds |
| Timeout | 10 seconds |
| Retries | 3 |
| Start Period | 120 seconds |

### 2.4 ECS Service

| Setting | Value |
|---------|-------|
| Service Name | `ace-microservice-service` |
| Service ARN | `arn:aws:ecs:ap-south-1:223643972423:service/ninja-cluster/ace-microservice-service` |
| Desired Count | 1 |
| Launch Type | FARGATE |
| Platform Version | LATEST |

---

## 3. Networking & Load Balancing

### 3.1 VPC Configuration

| Setting | Value |
|---------|-------|
| VPC Name | `s4c-nonprod-vpc` |
| VPC ID | `vpc-0a4f4778427f942c1` |
| CIDR Block | 10.101.0.0/16 |
| Subnet 1 | `subnet-01bad88711821802f` (s4c-nonprod-web-subnet-1a) |
| Subnet 2 | `subnet-03e459cac90b9742f` (s4c-nonprod-web-subnet-1b) |

### 3.2 Application Load Balancer

| Setting | Value |
|---------|-------|
| Name | `ninja-alb-staging` |
| ALB ARN | `arn:aws:elasticloadbalancing:ap-south-1:223643972423:loadbalancer/app/ninja-alb-staging/806020821d0ea50b` |
| DNS Name | `ninja-alb-staging-823993315.ap-south-1.elb.amazonaws.com` |
| Scheme | Internet-facing |
| Type | Application |

### 3.3 Listener Rule

| Setting | Value |
|---------|-------|
| Listener | HTTP:80 |
| Listener ARN | `arn:aws:elasticloadbalancing:ap-south-1:223643972423:listener/app/ninja-alb-staging/806020821d0ea50b/15b20dfb32b99467` |
| Rule Priority | 10 |
| Path Pattern | `/ace/*` |
| Action | Forward to `ace-microservice-tg` |

### 3.4 Target Group

| Setting | Value |
|---------|-------|
| Name | `ace-microservice-tg` |
| Target Group ARN | `arn:aws:elasticloadbalancing:ap-south-1:223643972423:targetgroup/ace-microservice-tg/db15602418ae8c85` |
| Target Type | IP addresses |
| Protocol:Port | HTTP:3001 |
| VPC | `vpc-0a4f4778427f942c1` |
| Health Check Path | `/health` |
| Health Check Protocol | HTTP |
| Health Check Interval | 30 seconds |
| Healthy Threshold | 5 |
| Unhealthy Threshold | 2 |

### 3.5 Security Groups

#### ACE ECS Security Group

| Setting | Value |
|---------|-------|
| Name | `ace-ecs-sg` |
| Group ID | `sg-0684f9110f1ec8645` |
| Description | Security group for ACE microservice |
| VPC | `vpc-0a4f4778427f942c1` |

**Inbound Rules:**

| Type | Protocol | Port | Source | Description |
|------|----------|------|--------|-------------|
| Custom TCP | TCP | 3001 | `sg-02a33930002dfae4b` (ninja-alb-sg) | ALB to ECS |

**Outbound Rules:**

| Type | Protocol | Port | Destination | Description |
|------|----------|------|-------------|-------------|
| All traffic | All | All | 0.0.0.0/0 | Allow all outbound |

---

## 4. CloudWatch Logging

| Setting | Value |
|---------|-------|
| Log Group | `/ecs/ace-microservice` |
| Log Stream Prefix | `ecs` |
| Retention | Default (Never expire) |

### View Logs

```bash
# Tail recent logs
aws logs tail /ecs/ace-microservice --region ap-south-1 --since 30m

# Filter for errors
aws logs filter-log-events \
  --log-group-name /ecs/ace-microservice \
  --region ap-south-1 \
  --filter-pattern "ERROR"
```

---

## 5. API Endpoints

### 5.1 Health Check

```
GET http://ninja-alb-staging-823993315.ap-south-1.elb.amazonaws.com/ace/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "ace-microservice",
  "timestamp": "2025-12-24T09:59:46.327Z"
}
```

### 5.2 EPUB Audit

```
POST http://ninja-alb-staging-823993315.ap-south-1.elb.amazonaws.com/ace/audit
Content-Type: multipart/form-data

Body: epub (file)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "score": 85,
    "violations": [
      {
        "ruleId": "METADATA-ACCESSMODE",
        "ruleName": "metadata-accessmode",
        "impact": "critical",
        "description": "Publications must declare the 'schema:accessMode' metadata",
        "wcagCriteria": [],
        "location": "EPUB/content.opf"
      }
    ],
    "metadata": {
      "conformsTo": [],
      "accessMode": [],
      "accessibilityFeature": [],
      "accessibilityHazard": [],
      "accessibilitySummary": null
    },
    "summary": {
      "critical": 1,
      "serious": 0,
      "moderate": 2,
      "minor": 1,
      "total": 4
    },
    "outlines": {
      "toc": [],
      "headings": []
    },
    "fileName": "book.epub",
    "auditDuration": 15234
  }
}
```

---

## 6. Ninja Backend Integration

### 6.1 Environment Variable

Add to Ninja backend (Replit Secrets):

| Key | Value |
|-----|-------|
| `ACE_SERVICE_URL` | `http://ninja-alb-staging-823993315.ap-south-1.elb.amazonaws.com/ace` |

### 6.2 Integration Files

| File | Purpose |
|------|---------|
| `src/services/epub/ace-client.service.ts` | HTTP client for ACE microservice |
| `src/services/epub/epub-audit.service.ts` | Integrates ACE into audit pipeline |

### 6.3 Audit Pipeline Flow

```
EPUB Upload
    │
    ▼
┌─────────────┐
│  EPUBCheck  │  (Local - Java)
└─────────────┘
    │
    ▼
┌─────────────┐
│     ACE     │  (AWS ECS - via HTTP)
└─────────────┘
    │
    ▼
┌─────────────┐
│ JS Auditor  │  (Local - Node.js)
└─────────────┘
    │
    ▼
Combined Results
```

---

## 7. Deployment & Operations

### 7.1 Initial Deployment (Completed)

```bash
# 1. Create ECR repository
aws ecr create-repository --repository-name ace-microservice --region ap-south-1

# 2. Build and push Docker image
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 223643972423.dkr.ecr.ap-south-1.amazonaws.com
docker build -t ace-microservice .
docker tag ace-microservice:latest 223643972423.dkr.ecr.ap-south-1.amazonaws.com/ace-microservice:latest
docker push 223643972423.dkr.ecr.ap-south-1.amazonaws.com/ace-microservice:latest

# 3. Create log group
aws logs create-log-group --log-group-name /ecs/ace-microservice --region ap-south-1

# 4. Register task definition
aws ecs register-task-definition --cli-input-json file://ace-task-definition.json --region ap-south-1

# 5. Create target group
aws elbv2 create-target-group --name ace-microservice-tg --protocol HTTP --port 3001 --vpc-id vpc-0a4f4778427f942c1 --target-type ip --health-check-path /health --region ap-south-1

# 6. Create ALB listener rule
aws elbv2 create-rule --listener-arn <LISTENER_ARN> --priority 10 --conditions Field=path-pattern,Values='/ace/*' --actions Type=forward,TargetGroupArn=<TARGET_GROUP_ARN> --region ap-south-1

# 7. Create security group and rules
aws ec2 create-security-group --group-name ace-ecs-sg --description "Security group for ACE microservice" --vpc-id vpc-0a4f4778427f942c1 --region ap-south-1
aws ec2 authorize-security-group-ingress --group-id <SG_ID> --protocol tcp --port 3001 --source-group sg-02a33930002dfae4b --region ap-south-1

# 8. Create ECS service
aws ecs create-service --cluster ninja-cluster --service-name ace-microservice-service --task-definition ace-microservice-task:1 --desired-count 1 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[subnet-01bad88711821802f,subnet-03e459cac90b9742f],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" --load-balancers "targetGroupArn=<TG_ARN>,containerName=ace-microservice,containerPort=3001" --region ap-south-1
```

### 7.2 Update Deployment

To deploy a new version:

```bash
# 1. Build new image locally
cd C:\Users\avrve\projects\ace-microservice
npm run build
docker build -t ace-microservice .

# 2. Tag and push to ECR
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 223643972423.dkr.ecr.ap-south-1.amazonaws.com
docker tag ace-microservice:latest 223643972423.dkr.ecr.ap-south-1.amazonaws.com/ace-microservice:latest
docker push 223643972423.dkr.ecr.ap-south-1.amazonaws.com/ace-microservice:latest

# 3. Force new deployment
aws ecs update-service --cluster ninja-cluster --service ace-microservice-service --force-new-deployment --region ap-south-1
```

### 7.3 Monitoring Commands

```bash
# Check service status
aws ecs describe-services --cluster ninja-cluster --services ace-microservice-service --region ap-south-1 --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'

# View running tasks
aws ecs list-tasks --cluster ninja-cluster --service-name ace-microservice-service --region ap-south-1

# Check target health
aws elbv2 describe-target-health --target-group-arn arn:aws:elasticloadbalancing:ap-south-1:223643972423:targetgroup/ace-microservice-tg/db15602418ae8c85 --region ap-south-1

# View recent logs
aws logs tail /ecs/ace-microservice --region ap-south-1 --since 30m --format short
```

### 7.4 Troubleshooting

| Issue | Command |
|-------|---------|
| Service not starting | `aws ecs describe-services --cluster ninja-cluster --services ace-microservice-service --region ap-south-1` |
| Task failures | `aws ecs describe-tasks --cluster ninja-cluster --tasks <TASK_ARN> --region ap-south-1` |
| Container errors | `aws logs tail /ecs/ace-microservice --region ap-south-1 --since 1h` |
| Health check failing | `curl http://ninja-alb-staging-823993315.ap-south-1.elb.amazonaws.com/ace/health` |

---

## 8. Docker Image Details

### 8.1 Base Image

`node:20-slim`

### 8.2 System Dependencies

The Dockerfile installs the following for Electron/ACE:

- **Xvfb** - Virtual framebuffer for headless display
- **X11 libraries** - libx11-xcb1, libxcb1, libxcomposite1, libxcursor1, libxdamage1, libxext6, libxfixes3, libxi6, libxrandr2, libxrender1, libxss1, libxtst6
- **GTK** - libgtk-3-0, libgbm1
- **Audio** - libasound2 (required by Electron)
- **Fonts** - fonts-liberation, fonts-noto-color-emoji
- **Security** - libnss3, libnspr4, ca-certificates
- **D-Bus** - libdbus-1-3

### 8.3 Environment Variables in Container

| Variable | Value | Purpose |
|----------|-------|---------|
| NODE_ENV | production | Runtime environment |
| PORT | 3001 | Server port |
| DISPLAY | :99 | Xvfb virtual display |
| ELECTRON_DISABLE_SANDBOX | true | Required for root user |
| ELECTRON_NO_SANDBOX | 1 | Required for root user |

---

## 9. Cost Estimation

| Resource | Configuration | Estimated Monthly Cost |
|----------|--------------|------------------------|
| ECS Fargate | 1 vCPU, 2GB RAM, ~720 hrs | ~$30-40 |
| ALB | Shared with ninja-backend | Included |
| ECR | < 5GB storage | < $1 |
| CloudWatch Logs | < 5GB/month | < $3 |
| **Total** | | **~$35-45/month** |

---

## 10. Security Considerations

1. **Network Isolation**: ACE service only accepts traffic from ALB security group
2. **No Public IP Required**: Service runs in private subnets (though currently ENABLED for ECS)
3. **No Secrets**: Service has no database or sensitive credentials
4. **File Handling**: Uploaded EPUBs are processed and deleted immediately
5. **Timeout Protection**: 120-second timeout prevents resource exhaustion

---

## 11. Resource Summary Table

| Resource Type | Name/ID | Purpose |
|---------------|---------|---------|
| ECR Repository | `ace-microservice` | Docker image storage |
| ECS Cluster | `ninja-cluster` | Container orchestration |
| ECS Service | `ace-microservice-service` | Container management |
| Task Definition | `ace-microservice-task:1` | Container configuration |
| Target Group | `ace-microservice-tg` | ALB routing target |
| Security Group | `ace-ecs-sg` (sg-0684f9110f1ec8645) | Network access control |
| ALB Rule | Priority 10, /ace/* | Path-based routing |
| Log Group | `/ecs/ace-microservice` | Application logs |

---

**Document Version:** 1.0
**Created:** December 24, 2025
**Author:** Claude Code
