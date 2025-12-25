# ACE Microservice Production Deployment Guide

**Document:** Production Deployment Checklist
**Status:** For Future Reference
**Created:** December 24, 2025

---

## Prerequisites

Before deploying to production, ensure you have:

- [ ] AWS CLI configured with production account credentials
- [ ] Docker Desktop installed and running
- [ ] Access to production AWS account
- [ ] Production AWS infrastructure guide (for VPC, subnet, ALB details)
- [ ] ACE microservice codebase built and tested locally

---

## Step 1: Gather Production Environment Details

Collect these values from your production AWS infrastructure guide:

| Setting | Staging Value | Production Value |
|---------|---------------|------------------|
| AWS Account ID | 223643972423 | _______________ |
| Region | ap-south-1 | _______________ |
| VPC ID | vpc-0a4f4778427f942c1 | _______________ |
| Subnet 1 | subnet-01bad88711821802f | _______________ |
| Subnet 2 | subnet-03e459cac90b9742f | _______________ |
| ECS Cluster Name | ninja-cluster | _______________ |
| ALB Name | ninja-alb-staging | _______________ |
| ALB Security Group ID | sg-02a33930002dfae4b | _______________ |
| Task Execution Role ARN | arn:aws:iam::223643972423:role/ecsTaskExecutionRole | _______________ |

---

## Step 2: Create ECR Repository (Production)

```bash
# Set production account ID
export PROD_ACCOUNT_ID=<PRODUCTION_ACCOUNT_ID>
export PROD_REGION=<PRODUCTION_REGION>

# Create ECR repository
aws ecr create-repository \
  --repository-name ace-microservice \
  --region $PROD_REGION \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

**Expected Output:** Repository URI like `<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/ace-microservice`

---

## Step 3: Build and Push Docker Image

```bash
# Navigate to project directory
cd C:\Users\avrve\projects\ace-microservice

# Build TypeScript
npm run build

# Build Docker image
docker build -t ace-microservice .

# Login to production ECR
aws ecr get-login-password --region $PROD_REGION | docker login --username AWS --password-stdin $PROD_ACCOUNT_ID.dkr.ecr.$PROD_REGION.amazonaws.com

# Tag image for production
docker tag ace-microservice:latest $PROD_ACCOUNT_ID.dkr.ecr.$PROD_REGION.amazonaws.com/ace-microservice:latest

# Push to production ECR
docker push $PROD_ACCOUNT_ID.dkr.ecr.$PROD_REGION.amazonaws.com/ace-microservice:latest
```

---

## Step 4: Create CloudWatch Log Group

```bash
aws logs create-log-group \
  --log-group-name /ecs/ace-microservice \
  --region $PROD_REGION
```

---

## Step 5: Create Task Definition

Create file `ace-task-definition-prod.json`:

```json
{
  "family": "ace-microservice-task",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<PROD_ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "ace-microservice",
      "image": "<PROD_ACCOUNT_ID>.dkr.ecr.<PROD_REGION>.amazonaws.com/ace-microservice:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "3001"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ace-microservice",
          "awslogs-region": "<PROD_REGION>",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1"],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 120
      }
    }
  ]
}
```

**Register the task definition:**

```bash
aws ecs register-task-definition \
  --cli-input-json file://ace-task-definition-prod.json \
  --region $PROD_REGION
```

---

## Step 6: Create Target Group

```bash
# Get production VPC ID
export PROD_VPC_ID=<PRODUCTION_VPC_ID>

aws elbv2 create-target-group \
  --name ace-microservice-tg \
  --protocol HTTP \
  --port 3001 \
  --vpc-id $PROD_VPC_ID \
  --target-type ip \
  --health-check-path /health \
  --health-check-protocol HTTP \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --region $PROD_REGION
```

**Save the Target Group ARN from output.**

---

## Step 7: Get ALB Listener ARN

```bash
# Get ALB ARN
export PROD_ALB_NAME=<PRODUCTION_ALB_NAME>

aws elbv2 describe-load-balancers \
  --names $PROD_ALB_NAME \
  --region $PROD_REGION \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text

# Get Listener ARN (use ALB ARN from above)
aws elbv2 describe-listeners \
  --load-balancer-arn <ALB_ARN> \
  --region $PROD_REGION \
  --query 'Listeners[0].ListenerArn' \
  --output text
```

---

## Step 8: Create ALB Listener Rule

```bash
export PROD_LISTENER_ARN=<LISTENER_ARN_FROM_STEP_7>
export PROD_TARGET_GROUP_ARN=<TARGET_GROUP_ARN_FROM_STEP_6>

aws elbv2 create-rule \
  --listener-arn $PROD_LISTENER_ARN \
  --priority 10 \
  --conditions Field=path-pattern,Values='/ace/*' \
  --actions Type=forward,TargetGroupArn=$PROD_TARGET_GROUP_ARN \
  --region $PROD_REGION
```

---

## Step 9: Create Security Group

```bash
# Create security group
aws ec2 create-security-group \
  --group-name ace-ecs-sg \
  --description "Security group for ACE microservice" \
  --vpc-id $PROD_VPC_ID \
  --region $PROD_REGION

# Save the Security Group ID from output
export ACE_SG_ID=<SECURITY_GROUP_ID>

# Get production ALB security group ID
export PROD_ALB_SG_ID=<PRODUCTION_ALB_SECURITY_GROUP_ID>

# Allow traffic from ALB to ACE on port 3001
aws ec2 authorize-security-group-ingress \
  --group-id $ACE_SG_ID \
  --protocol tcp \
  --port 3001 \
  --source-group $PROD_ALB_SG_ID \
  --region $PROD_REGION
```

---

## Step 10: Create ECS Service

```bash
export PROD_SUBNET_1=<PRODUCTION_SUBNET_1>
export PROD_SUBNET_2=<PRODUCTION_SUBNET_2>
export PROD_CLUSTER_NAME=<PRODUCTION_ECS_CLUSTER>

aws ecs create-service \
  --cluster $PROD_CLUSTER_NAME \
  --service-name ace-microservice-service \
  --task-definition ace-microservice-task:1 \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PROD_SUBNET_1,$PROD_SUBNET_2],securityGroups=[$ACE_SG_ID],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$PROD_TARGET_GROUP_ARN,containerName=ace-microservice,containerPort=3001" \
  --region $PROD_REGION
```

---

## Step 11: Verify Deployment

### 11.1 Check Service Status

```bash
aws ecs describe-services \
  --cluster $PROD_CLUSTER_NAME \
  --services ace-microservice-service \
  --region $PROD_REGION \
  --query 'services[0].{status:status,runningCount:runningCount,desiredCount:desiredCount}'
```

Wait until `runningCount` equals `desiredCount` (1).

### 11.2 Check Target Health

```bash
aws elbv2 describe-target-health \
  --target-group-arn $PROD_TARGET_GROUP_ARN \
  --region $PROD_REGION
```

Wait until target shows `healthy`.

### 11.3 Test Health Endpoint

```bash
curl http://<PRODUCTION_ALB_DNS>/ace/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "service": "ace-microservice",
  "timestamp": "..."
}
```

### 11.4 Test Audit Endpoint (Optional)

```bash
curl -X POST -F "epub=@/path/to/test.epub" http://<PRODUCTION_ALB_DNS>/ace/audit
```

---

## Step 12: Configure Ninja Backend (Production)

Add environment variable to production Ninja backend:

| Key | Value |
|-----|-------|
| `ACE_SERVICE_URL` | `http://<PRODUCTION_ALB_DNS>/ace` |

Restart the production backend to apply the configuration.

---

## Step 13: Post-Deployment Verification

- [ ] Health endpoint returns healthy status
- [ ] Audit endpoint processes EPUB files
- [ ] CloudWatch logs show successful requests
- [ ] Ninja backend successfully calls ACE service
- [ ] End-to-end EPUB audit works with ACE results included

---

## Rollback Procedure

If issues occur after deployment:

### Option 1: Scale Down Service

```bash
aws ecs update-service \
  --cluster $PROD_CLUSTER_NAME \
  --service ace-microservice-service \
  --desired-count 0 \
  --region $PROD_REGION
```

### Option 2: Remove ALB Rule

```bash
# List rules to find the ACE rule ARN
aws elbv2 describe-rules \
  --listener-arn $PROD_LISTENER_ARN \
  --region $PROD_REGION

# Delete the rule
aws elbv2 delete-rule \
  --rule-arn <ACE_RULE_ARN> \
  --region $PROD_REGION
```

### Option 3: Remove ACE_SERVICE_URL from Backend

Remove or comment out `ACE_SERVICE_URL` from production Ninja backend. The backend will gracefully skip ACE audits.

---

## Production Considerations

### Scaling

To increase capacity:

```bash
# Scale to 2 instances
aws ecs update-service \
  --cluster $PROD_CLUSTER_NAME \
  --service ace-microservice-service \
  --desired-count 2 \
  --region $PROD_REGION
```

### Resource Sizing

| Environment | vCPU | Memory | Instances |
|-------------|------|--------|-----------|
| Staging | 1 | 2 GB | 1 |
| Production (Low) | 1 | 2 GB | 1-2 |
| Production (High) | 2 | 4 GB | 2-4 |

### Monitoring Alerts (Recommended)

Set up CloudWatch alarms for:

- ECS service CPU > 80%
- ECS service memory > 80%
- Target group unhealthy hosts > 0
- 5xx error rate > 1%

---

## Quick Reference: Production Commands

```bash
# View service status
aws ecs describe-services --cluster <CLUSTER> --services ace-microservice-service --region <REGION>

# View logs
aws logs tail /ecs/ace-microservice --region <REGION> --since 30m

# Force new deployment (after image update)
aws ecs update-service --cluster <CLUSTER> --service ace-microservice-service --force-new-deployment --region <REGION>

# Scale service
aws ecs update-service --cluster <CLUSTER> --service ace-microservice-service --desired-count <N> --region <REGION>

# Check target health
aws elbv2 describe-target-health --target-group-arn <TG_ARN> --region <REGION>
```

---

## Checklist Summary

| Step | Description | Completed |
|------|-------------|-----------|
| 1 | Gather production environment details | [ ] |
| 2 | Create ECR repository | [ ] |
| 3 | Build and push Docker image | [ ] |
| 4 | Create CloudWatch log group | [ ] |
| 5 | Create task definition | [ ] |
| 6 | Create target group | [ ] |
| 7 | Get ALB listener ARN | [ ] |
| 8 | Create ALB listener rule | [ ] |
| 9 | Create security group | [ ] |
| 10 | Create ECS service | [ ] |
| 11 | Verify deployment | [ ] |
| 12 | Configure Ninja backend | [ ] |
| 13 | Post-deployment verification | [ ] |

---

**Document Version:** 1.0
**Created:** December 24, 2025
**Author:** Claude Code
