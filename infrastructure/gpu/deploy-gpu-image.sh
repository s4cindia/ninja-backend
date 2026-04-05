#!/bin/bash
# =============================================================================
# Build and push the GPU Docker image manually (first deploy or debugging)
# After first deploy, the CI/CD workflow handles this automatically.
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID must be set}"
ECR_REPO="ninja-docling-service-gpu"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

echo "=== Ninja Docling GPU — Build & Push ==="
echo "Region: $REGION"
echo "Image:  $IMAGE_URI"
echo ""

# Authenticate ECR
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Build GPU image
echo ">>> Building GPU image (this may take 10-15 min first time)..."
docker build \
  -f docling-service/Dockerfile.gpu \
  -t "${ECR_REPO}:${IMAGE_TAG}" \
  docling-service/

# Tag and push
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${IMAGE_URI}"
echo ">>> Pushing to ECR..."
docker push "${IMAGE_URI}"

# Also tag as latest
docker tag "${ECR_REPO}:${IMAGE_TAG}" \
  "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"
docker push "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"

echo ""
echo "=== Push complete ==="
echo "Image: $IMAGE_URI"
echo ""
echo "To deploy to ECS:"
echo "  aws ecs update-service --cluster ninja-cluster --service ninja-docling-service-gpu --desired-count 1 --force-new-deployment"
