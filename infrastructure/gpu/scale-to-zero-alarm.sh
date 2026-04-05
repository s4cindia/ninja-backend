#!/bin/bash
# =============================================================================
# Scale-to-Zero: CloudWatch Alarm that scales down the GPU ASG when idle
# Triggers when no ECS tasks are running for 15 minutes
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
CLUSTER="ninja-cluster"
SERVICE="ninja-docling-service-gpu"
ASG_NAME="ninja-docling-gpu-asg"

echo "=== Setting up scale-to-zero alarm ==="

# Create scaling policy to set desired capacity to 0
POLICY_ARN=$(aws autoscaling put-scaling-policy \
  --auto-scaling-group-name "$ASG_NAME" \
  --policy-name "ninja-docling-gpu-scale-to-zero" \
  --policy-type "StepScaling" \
  --adjustment-type "ExactCapacity" \
  --step-adjustments "MetricIntervalUpperBound=0,ScalingAdjustment=0" \
  --region "$REGION" \
  --query "PolicyARN" --output text)

echo "Scaling policy ARN: $POLICY_ARN"

# Create CloudWatch alarm: triggers when running task count is 0 for 15 minutes
aws cloudwatch put-metric-alarm \
  --alarm-name "ninja-docling-gpu-idle" \
  --alarm-description "Scale down GPU instance when no Docling tasks are running for 15 min" \
  --namespace "AWS/ECS" \
  --metric-name "RunningTaskCount" \
  --dimensions "Name=ClusterName,Value=$CLUSTER" "Name=ServiceName,Value=$SERVICE" \
  --statistic "Maximum" \
  --period 300 \
  --evaluation-periods 3 \
  --threshold 0.5 \
  --comparison-operator "LessThanThreshold" \
  --alarm-actions "$POLICY_ARN" \
  --treat-missing-data "breaching" \
  --region "$REGION"

echo "CloudWatch alarm created: ninja-docling-gpu-idle"
echo "  - Triggers when RunningTaskCount < 1 for 15 minutes (3 x 5min periods)"
echo "  - Action: Scale ASG to 0 instances"
