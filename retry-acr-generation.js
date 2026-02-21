require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function retryAcr() {
  console.log('🔄 Forcing workflow back to ACR_GENERATION...');

  // Directly update the state in the database
  await prisma.workflowInstance.update({
    where: { id: workflowId },
    data: {
      currentState: 'ACR_GENERATION',
      errorMessage: null,
    }
  });

  console.log('✅ Workflow state updated to ACR_GENERATION');

  // Now trigger the workflow agent
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Checking final state...');

  const workflow = await prisma.workflowInstance.findUnique({
    where: { id: workflowId }
  });

  console.log('   Current State:', workflow.currentState);
  console.log('   Error:', workflow.errorMessage || 'none');

  await prisma.$disconnect();
}

retryAcr().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
