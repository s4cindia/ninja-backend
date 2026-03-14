#!/bin/bash
set -e

REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID must be set}"
ECR_REPO="ninja-docling-service"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

echo "=== Ninja Docling Service — Deploy ==="
echo "Region:    ${REGION}"
echo "Image:     ${IMAGE_URI}"

# Authenticate ECR
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Build
docker build -t "${ECR_REPO}:${IMAGE_TAG}" ./docling-service/

# Tag and push
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${IMAGE_URI}"
docker push "${IMAGE_URI}"

# Register task definition
aws ecs register-task-definition \
  --cli-input-json file://infrastructure/ecs/docling-task-definition.json \
  --region "${REGION}"

echo ""
echo "=== Deploy complete ==="
echo "To update the ECS service:"
echo "  aws ecs update-service \\"
echo "    --cluster ninja-staging \\"
echo "    --service ninja-docling-service \\"
echo "    --task-definition ninja-docling-service \\"
echo "    --region ${REGION}"
