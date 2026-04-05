#!/bin/bash
# =============================================================================
# Ninja Docling GPU Infrastructure Setup
# Creates: Launch Template, ASG, ECS Capacity Provider, CloudWatch Log Group
# Instance: g4dn.xlarge (1x T4 GPU, 4 vCPU, 16 GB RAM)
# Region: ap-south-1
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
CLUSTER="ninja-cluster"
ACCOUNT_ID="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID must be set}"

# --- Configuration ---
LAUNCH_TEMPLATE_NAME="ninja-docling-gpu-lt"
ASG_NAME="ninja-docling-gpu-asg"
CAPACITY_PROVIDER_NAME="ninja-docling-gpu-cp"
INSTANCE_TYPE="g4dn.xlarge"
KEY_NAME="${EC2_KEY_NAME:-}"  # Optional SSH key for debugging

# ECS-optimized GPU AMI for ap-south-1 (Amazon Linux 2 + NVIDIA drivers + ECS agent)
# Find latest: aws ssm get-parameters-by-path --path /aws/service/ecs/optimized-ami/amazon-linux-2/gpu
GPU_AMI=$(aws ssm get-parameter \
  --name "/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id" \
  --region "$REGION" \
  --query "Parameter.Value" --output text)

echo "=== Ninja Docling GPU Infrastructure Setup ==="
echo "Region:    $REGION"
echo "Cluster:   $CLUSTER"
echo "Instance:  $INSTANCE_TYPE"
echo "GPU AMI:   $GPU_AMI"
echo ""

# --- Get existing networking from the ECS cluster/service ---
echo ">>> Fetching VPC/Subnet/SG from existing ECS service..."
SERVICE_INFO=$(aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services ninja-docling-service \
  --region "$REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration')

SUBNETS=$(echo "$SERVICE_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d['subnets']))")
SECURITY_GROUPS=$(echo "$SERVICE_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d['securityGroups']))")
FIRST_SUBNET=$(echo "$SUBNETS" | cut -d',' -f1)

echo "Subnets:   $SUBNETS"
echo "SGs:       $SECURITY_GROUPS"
echo ""

# --- 1. Create CloudWatch Log Group ---
echo ">>> Creating CloudWatch log group..."
aws logs create-log-group \
  --log-group-name "/ecs/ninja-docling-service-gpu" \
  --region "$REGION" 2>/dev/null || echo "  (log group already exists)"

# --- 2. Create Launch Template ---
echo ">>> Creating EC2 launch template..."

USER_DATA=$(cat <<'USERDATA' | base64 -w0
#!/bin/bash
echo "ECS_CLUSTER=ninja-cluster" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_GPU_SUPPORT=true" >> /etc/ecs/ecs.config
echo "ECS_AVAILABLE_LOGGING_DRIVERS=[\"awslogs\",\"json-file\"]" >> /etc/ecs/ecs.config
USERDATA
)

LAUNCH_TEMPLATE_DATA=$(cat <<EOF
{
  "ImageId": "$GPU_AMI",
  "InstanceType": "$INSTANCE_TYPE",
  "IamInstanceProfile": {
    "Name": "ecsInstanceRole"
  },
  "NetworkInterfaces": [
    {
      "DeviceIndex": 0,
      "AssociatePublicIpAddress": true,
      "Groups": [$(echo "$SECURITY_GROUPS" | sed 's/,/","/g; s/^/"/; s/$/"/')],
      "SubnetId": "$FIRST_SUBNET"
    }
  ],
  "UserData": "$USER_DATA",
  "TagSpecifications": [
    {
      "ResourceType": "instance",
      "Tags": [
        { "Key": "Name", "Value": "ninja-docling-gpu" },
        { "Key": "Project", "Value": "ninja" },
        { "Key": "Service", "Value": "docling" }
      ]
    }
  ],
  "BlockDeviceMappings": [
    {
      "DeviceName": "/dev/xvda",
      "Ebs": {
        "VolumeSize": 50,
        "VolumeType": "gp3",
        "DeleteOnTermination": true
      }
    }
  ]
}
EOF
)

# Add SSH key if provided
if [ -n "$KEY_NAME" ]; then
  LAUNCH_TEMPLATE_DATA=$(echo "$LAUNCH_TEMPLATE_DATA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['KeyName'] = '$KEY_NAME'
json.dump(d, sys.stdout)
")
fi

aws ec2 create-launch-template \
  --launch-template-name "$LAUNCH_TEMPLATE_NAME" \
  --version-description "Docling GPU - g4dn.xlarge with T4" \
  --launch-template-data "$LAUNCH_TEMPLATE_DATA" \
  --region "$REGION"

echo "  Created: $LAUNCH_TEMPLATE_NAME"

# --- 3. Create Auto Scaling Group (min 0, max 1) ---
echo ">>> Creating Auto Scaling Group..."

aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name "$ASG_NAME" \
  --launch-template "LaunchTemplateName=$LAUNCH_TEMPLATE_NAME,Version=\$Latest" \
  --min-size 0 \
  --max-size 1 \
  --desired-capacity 0 \
  --vpc-zone-identifier "$SUBNETS" \
  --new-instances-protected-from-scale-in \
  --tags "Key=Name,Value=ninja-docling-gpu,PropagateAtLaunch=true" \
         "Key=AmazonECSManaged,Value=true,PropagateAtLaunch=true" \
  --region "$REGION"

echo "  Created: $ASG_NAME (min=0, max=1, desired=0)"

# --- 4. Create ECS Capacity Provider ---
echo ">>> Creating ECS Capacity Provider..."

aws ecs create-capacity-provider \
  --name "$CAPACITY_PROVIDER_NAME" \
  --auto-scaling-group-provider "autoScalingGroupArn=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names $ASG_NAME \
    --region $REGION \
    --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text),managedScaling={status=ENABLED,targetCapacity=100,minimumScalingStepSize=1,maximumScalingStepSize=1},managedTerminationProtection=ENABLED" \
  --region "$REGION"

echo "  Created: $CAPACITY_PROVIDER_NAME"

# --- 5. Attach Capacity Provider to ECS Cluster ---
echo ">>> Attaching capacity provider to cluster..."

# Get existing capacity providers
EXISTING_CPS=$(aws ecs describe-clusters \
  --clusters "$CLUSTER" \
  --region "$REGION" \
  --query 'clusters[0].capacityProviders' --output json)

# Add our new one
aws ecs put-cluster-capacity-providers \
  --cluster "$CLUSTER" \
  --capacity-providers $(echo "$EXISTING_CPS" | python3 -c "
import sys, json
cps = json.load(sys.stdin)
cps.append('$CAPACITY_PROVIDER_NAME')
print(' '.join(cps))
") \
  --default-capacity-provider-strategy "capacityProvider=FARGATE,weight=1" \
  --region "$REGION"

echo "  Attached $CAPACITY_PROVIDER_NAME to $CLUSTER"

# --- 6. Register GPU Task Definition ---
echo ">>> Registering GPU task definition..."

aws ecs register-task-definition \
  --cli-input-json file://infrastructure/ecs/docling-gpu-task-definition.json \
  --region "$REGION"

echo "  Registered: ninja-docling-service-gpu"

# --- 7. Create GPU ECS Service ---
echo ">>> Creating GPU ECS service..."

aws ecs create-service \
  --cluster "$CLUSTER" \
  --service-name "ninja-docling-service-gpu" \
  --task-definition "ninja-docling-service-gpu" \
  --desired-count 0 \
  --capacity-provider-strategy "capacityProvider=$CAPACITY_PROVIDER_NAME,weight=1,base=0" \
  --network-configuration "awsvpcConfiguration={subnets=[$(echo $SUBNETS | sed 's/,/","/g; s/^/"/; s/$/"/')],securityGroups=[$(echo $SECURITY_GROUPS | sed 's/,/","/g; s/^/"/; s/$/"/')],assignPublicIp=ENABLED}" \
  --service-registries "registryArn=$(aws servicediscovery list-services \
    --region $REGION \
    --query "Services[?Name=='ninja-docling-service'].Arn" --output text)" \
  --region "$REGION"

echo "  Created service: ninja-docling-service-gpu (desired=0, scale-to-zero)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Infrastructure created:"
echo "  - Launch Template: $LAUNCH_TEMPLATE_NAME"
echo "  - Auto Scaling Group: $ASG_NAME (min=0, max=1)"
echo "  - Capacity Provider: $CAPACITY_PROVIDER_NAME (managed scaling)"
echo "  - ECS Service: ninja-docling-service-gpu (desired=0)"
echo "  - Log Group: /ecs/ninja-docling-service-gpu"
echo ""
echo "Next steps:"
echo "  1. Create ECR repo: aws ecr create-repository --repository-name ninja-docling-service-gpu"
echo "  2. Build and push GPU image (use build-docling-gpu.yml workflow or manual deploy)"
echo "  3. Update desired count to 1 to test: aws ecs update-service --cluster $CLUSTER --service ninja-docling-service-gpu --desired-count 1"
echo "  4. Once verified, update DOCLING_SERVICE_URL to point to GPU service"
echo "  5. Scale down old Fargate service"
