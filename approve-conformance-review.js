require('dotenv').config();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function approveConformance() {
  console.log('🔄 Approving Conformance Review for workflow:', workflowId);

  const { workflowService } = require('./dist/services/workflow/workflow.service');

  // Transition workflow (checking state machine for correct event name)
  const updated = await workflowService.transition(workflowId, 'CONFORMANCE_APPROVED', {
    approved: true,
    approvedAt: new Date().toISOString(),
    notes: 'Manual approval for testing - moving to ACR generation'
  });

  console.log('✅ Conformance Review approved!');
  console.log('   New state:', updated.currentState);

  // Trigger workflow agent to process the new state
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Check monitor-workflow.js for final state');
}

approveConformance().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
