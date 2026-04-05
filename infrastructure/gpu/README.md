# Docling GPU Infrastructure

GPU-accelerated Docling service running on ECS with EC2 (g4dn.xlarge / NVIDIA T4).

## Prerequisites

Before running `setup-gpu-infrastructure.sh`:

1. **ECR Repository** — create the GPU image repo:
   ```bash
   aws ecr create-repository --repository-name ninja-docling-service-gpu --region ap-south-1
   ```

2. **IAM Instance Profile** — the EC2 instances need `ecsInstanceRole`:
   ```bash
   # Check if it exists
   aws iam get-instance-profile --instance-profile-name ecsInstanceRole

   # If not, create it:
   aws iam create-role --role-name ecsInstanceRole \
     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam attach-role-policy --role-name ecsInstanceRole \
     --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role
   aws iam create-instance-profile --instance-profile-name ecsInstanceRole
   aws iam add-role-to-instance-profile --instance-profile-name ecsInstanceRole --role-name ecsInstanceRole
   ```

3. **CloudWatch Log Group** — created automatically by the setup script.

## Setup

```bash
export AWS_ACCOUNT_ID=223643972423
export AWS_REGION=ap-south-1

# 1. Run infrastructure setup
bash infrastructure/gpu/setup-gpu-infrastructure.sh

# 2. Set up scale-to-zero alarm
bash infrastructure/gpu/scale-to-zero-alarm.sh

# 3. Build and push GPU image (first time — manually; after that CI/CD handles it)
bash infrastructure/gpu/deploy-gpu-image.sh
```

## Architecture

```
ECS Cluster (ninja-cluster)
├── Fargate Capacity Provider (existing services)
│   ├── ninja-backend-task-service
│   └── ninja-docling-service (CPU — will be scaled down after GPU verified)
│
└── GPU Capacity Provider (ninja-docling-gpu-cp)
    └── ninja-docling-service-gpu (EC2 g4dn.xlarge)
        ├── Auto Scaling Group: min=0, max=1
        ├── Managed scaling: ECS scales ASG based on task demand
        └── Scale-to-zero: CloudWatch alarm after 15min idle
```

## Cost

| Scenario | Monthly Cost |
|----------|-------------|
| Spot pricing, ~2-3 hr/day | ~$75/month |
| Spot pricing, ~1 hr/day | ~$40/month |
| Idle (scale-to-zero) | $0 |

## Cutover Plan

1. Deploy GPU service alongside existing Fargate service
2. Test with a sample document (verify GPU acceleration and zone output)
3. Update `DOCLING_SERVICE_URL` env var to point to GPU service
4. Verify corpus processing works end-to-end
5. Scale down Fargate Docling service (`desired-count 0`)
6. After 1 week stable, delete old Fargate service and task definition
