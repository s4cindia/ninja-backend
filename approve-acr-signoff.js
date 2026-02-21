require('dotenv').config();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function approveAcrSignoff() {
  console.log('🔄 Approving ACR Signoff for workflow:', workflowId);
  console.log('   This will COMPLETE the workflow! 🎉\n');

  const { workflowService } = require('./dist/services/workflow/workflow.service');

  // Transition workflow to COMPLETED
  const updated = await workflowService.transition(workflowId, 'ACR_SIGNED', {
    approved: true,
    approvedAt: new Date().toISOString(),
    signedBy: 'test@example.com',
    notes: 'Final signoff - workflow automation test completed successfully!'
  });

  console.log('✅ ACR Signoff approved!');
  console.log('   New state:', updated.currentState);
  console.log('   Completed at:', updated.completedAt);

  // Trigger workflow agent (though COMPLETED is a terminal state)
  console.log('\n🤖 Triggering workflow agent...');
  const { workflowAgentService } = require('./dist/services/workflow/workflow-agent.service');
  await workflowAgentService.processWorkflowState(workflowId);

  console.log('\n✅ WORKFLOW AUTOMATION TEST COMPLETED! 🎊');
  console.log('\n📊 Run monitor-workflow.js for final summary');
}

approveAcrSignoff().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
