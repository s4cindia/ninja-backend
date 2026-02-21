require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function approveAIReview() {
  console.log('🔄 Approving AI Review for workflow:', workflowId);

  // Check current state
  const workflow = await prisma.workflowInstance.findUnique({
    where: { id: workflowId }
  });

  if (!workflow) {
    console.error('❌ Workflow not found');
    return;
  }

  console.log('Current state:', workflow.currentState);

  if (workflow.currentState !== 'AWAITING_AI_REVIEW') {
    console.error('❌ Workflow not in AWAITING_AI_REVIEW state');
    return;
  }

  // Transition workflow using workflowService
  const { workflowService } = require('./dist/services/workflow/workflow.service');

  const updated = await workflowService.transition(workflowId, 'AI_ACCEPTED', {
    approved: true,
    approvedAt: new Date().toISOString(),
    notes: 'Manual approval for testing'
  });

  console.log('✅ AI Review approved!');
  console.log('New state:', updated.currentState);
  console.log('\n👀 Watch backend logs for workflow agent processing...');

  await prisma.$disconnect();
}

approveAIReview().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
