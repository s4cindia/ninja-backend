#!/bin/bash

# Sprint 9 Workflow Local Test Script
# This script helps you test the workflow functionality locally

set -e

echo "🚀 Sprint 9 Workflow Test Script"
echo "=================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="http://localhost:3000"
AUTH_TOKEN="${AUTH_TOKEN:-}" # Set via environment variable

# Check if backend is running
echo "📡 Checking if backend is running..."
if curl -s "$BASE_URL/api/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Backend is running"
else
    echo -e "${RED}✗${NC} Backend is not running!"
    echo "   Please start the backend first: npm run dev"
    exit 1
fi

# Check if Redis is running (required for BullMQ)
echo "📊 Checking Redis connection..."
if redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Redis is running"
else
    echo -e "${YELLOW}⚠${NC}  Redis might not be running (required for workflow queue)"
    echo "   Start Redis: redis-server (or wsl redis-server on Windows)"
fi

echo ""
echo "🧪 Testing Workflow API Endpoints"
echo "===================================="

# Function to make API call
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3

    if [ -z "$AUTH_TOKEN" ]; then
        echo -e "${YELLOW}⚠${NC}  No AUTH_TOKEN set, request may fail"
        curl -s -X "$method" "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data"
    else
        curl -s -X "$method" "$BASE_URL$endpoint" \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data"
    fi
}

# Test 1: Health check
echo ""
echo "Test 1: Health Check"
echo "--------------------"
HEALTH=$(curl -s "$BASE_URL/api/health" || echo "{}")
echo "$HEALTH" | jq '.' 2>/dev/null || echo "$HEALTH"

# Test 2: Create workflow (requires file ID)
echo ""
echo "Test 2: Create Workflow"
echo "-----------------------"
echo "Note: You need a valid fileId from your database."
echo "Example file ID: $(uuidgen | tr '[:upper:]' '[:lower:]')"
echo ""
echo "To create a workflow, run:"
echo "  export AUTH_TOKEN='your-jwt-token'"
echo "  export FILE_ID='your-file-uuid'"
echo "  curl -X POST $BASE_URL/api/workflows \\"
echo "    -H \"Authorization: Bearer \$AUTH_TOKEN\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"fileId\": \"'\$FILE_ID'\", \"vpatEditions\": [\"VPAT2.5-WCAG\"]}'"

# If FILE_ID is set, try to create workflow
if [ -n "$FILE_ID" ]; then
    echo ""
    echo "Creating workflow with FILE_ID=$FILE_ID..."
    WORKFLOW_RESPONSE=$(api_call POST "/api/workflows" "{\"fileId\": \"$FILE_ID\", \"vpatEditions\": [\"VPAT2.5-WCAG\"]}")
    echo "$WORKFLOW_RESPONSE" | jq '.' 2>/dev/null || echo "$WORKFLOW_RESPONSE"

    # Extract workflow ID if successful
    WORKFLOW_ID=$(echo "$WORKFLOW_RESPONSE" | jq -r '.workflowId // .id' 2>/dev/null)

    if [ -n "$WORKFLOW_ID" ] && [ "$WORKFLOW_ID" != "null" ]; then
        echo -e "${GREEN}✓${NC} Workflow created: $WORKFLOW_ID"

        # Test 3: Get workflow status
        echo ""
        echo "Test 3: Get Workflow Status"
        echo "----------------------------"
        STATUS_RESPONSE=$(api_call GET "/api/workflows/$WORKFLOW_ID" "")
        echo "$STATUS_RESPONSE" | jq '.' 2>/dev/null || echo "$STATUS_RESPONSE"

        # Test 4: Get workflow timeline
        echo ""
        echo "Test 4: Get Workflow Timeline"
        echo "------------------------------"
        TIMELINE_RESPONSE=$(api_call GET "/api/workflows/$WORKFLOW_ID/timeline" "")
        echo "$TIMELINE_RESPONSE" | jq '.' 2>/dev/null || echo "$TIMELINE_RESPONSE"
    fi
fi

echo ""
echo "========================================="
echo "✅ Test script completed!"
echo ""
echo "Next steps:"
echo "  1. Set AUTH_TOKEN environment variable"
echo "  2. Set FILE_ID to a valid file UUID"
echo "  3. Run this script again: ./test-workflow-local.sh"
echo ""
echo "For WebSocket testing, see test-workflow-websocket.html"
echo "========================================="
