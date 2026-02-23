require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function forceAutoRemediation() {
  console.log('🔄 Forcing workflow back to AUTO_REMEDIATION...');

  // Directly update the state in the database
  await prisma.workflowInstance.update({
    where: { id: workflowId },
    data: {
      currentState: 'AUTO_REMEDIATION',
      errorMessage: null,
    }
  });

  console.log('✅ Workflow state updated to AUTO_REMEDIATION');

  // Now trigger the workflow agent
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Checking final state...');

  // Check final state
  const workflow = await prisma.workflowInstance.findUnique({
    where: { id: workflowId }
  });

  console.log('   Current State:', workflow.currentState);
  console.log('   Error:', workflow.errorMessage || 'none');

  await prisma.$disconnect();
}

forceAutoRemediation().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
