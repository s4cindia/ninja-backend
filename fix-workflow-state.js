require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';
const jobId = 'cc081e1d-20ee-4e39-929b-cafcc2dae799';

async function fixState() {
  console.log('🔧 Fixing workflow state...');

  const workflow = await prisma.workflowInstance.findUnique({
    where: { id: workflowId }
  });

  // Add jobId to state data
  const updatedState = {
    ...workflow.stateData,
    jobId: jobId,
    // Clear error from previous failed attempt
    errorMessage: undefined,
    errorStack: undefined,
    failedAt: undefined,
  };

  await prisma.workflowInstance.update({
    where: { id: workflowId },
    data: {
      stateData: updatedState,
      errorMessage: null, // Clear error at workflow level too
    }
  });

  console.log('✅ Workflow state fixed!');
  console.log('   Added jobId:', jobId);
  console.log('\n🤖 Now triggering workflow agent again...');

  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Check monitor-workflow.js for new state');

  await prisma.$disconnect();
}

fixState().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
