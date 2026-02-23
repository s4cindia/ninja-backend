require('dotenv').config();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function retryRemediation() {
  console.log('🔄 Moving workflow back to AUTO_REMEDIATION...');

  const { workflowService } = require('./dist/services/workflow/workflow.service');

  // Transition back to AUTO_REMEDIATION using RETRY event
  const updated = await workflowService.transition(workflowId, 'RETRY', {
    retrying: true,
    retriedAt: new Date().toISOString()
  });

  console.log('✅ Workflow state:', updated.currentState);

  // Now trigger the workflow agent to process AUTO_REMEDIATION
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Check monitor-workflow.js');
}

retryRemediation().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
