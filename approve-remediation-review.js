require('dotenv').config();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function approveRemediation() {
  console.log('🔄 Approving Remediation Review for workflow:', workflowId);

  const { workflowService } = require('./dist/services/workflow/workflow.service');

  // Transition workflow (use REMEDIATION_APPROVED event)
  const updated = await workflowService.transition(workflowId, 'REMEDIATION_APPROVED', {
    approved: true,
    approvedAt: new Date().toISOString(),
    notes: 'Manual approval for testing - continuing to certification phase'
  });

  console.log('✅ Remediation Review approved!');
  console.log('   New state:', updated.currentState);

  // Trigger workflow agent to process the new state
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ Done! Check monitor-workflow.js for final state');
}

approveRemediation().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
