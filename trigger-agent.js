require('dotenv').config();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function triggerAgent() {
  console.log('🤖 Triggering workflow agent for workflow:', workflowId);

  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');

  await workflowAgentService.processWorkflowState(workflowId);

  console.log('✅ Workflow agent processing completed!');
  console.log('👀 Check workflow state with monitor-workflow.js');
}

triggerAgent().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
