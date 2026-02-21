require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { nanoid } = require('nanoid');
const prisma = new PrismaClient();

const jobId = 'cc081e1d-20ee-4e39-929b-cafcc2dae799';

async function createDummyPlan() {
  console.log('🔨 Creating dummy remediation plan for testing...');

  // Get the original job to get tenantId and userId
  const originalJob = await prisma.job.findUnique({
    where: { id: jobId },
    select: { tenantId: true, userId: true, output: true }
  });

  if (!originalJob) {
    throw new Error('Original job not found');
  }

  // Create a simple remediation plan with the issues from the audit
  const auditOutput = originalJob.output;
  const violations = auditOutput?.violations || [];

  // Create dummy tasks for the first few violations
  const tasks = violations.slice(0, 3).map((v, i) => ({
    id: nanoid(),
    issueId: v.id || `issue-${i}`,
    type: 'auto', // Mark as auto-fixable for testing
    status: 'pending',
    description: v.description || v.help || 'Auto-fix test task',
    location: v.location || 'N/A',
    wcagCriteria: v.wcagCriteria || [],
    estimatedEffort: 'low',
    priority: 'medium',
    autoFixable: true,
    createdAt: new Date().toISOString(),
  }));

  const plan = {
    jobId: jobId,
    tasks: tasks,
    stats: {
      total: tasks.length,
      pending: tasks.length,
      completed: 0,
      failed: 0,
      autoFixable: tasks.length,
      quickFixable: 0,
      manualRequired: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Create the BATCH_VALIDATION job to store the plan
  const planJob = await prisma.job.create({
    data: {
      id: nanoid(),
      tenantId: originalJob.tenantId,
      userId: originalJob.userId,
      type: 'BATCH_VALIDATION',
      status: 'COMPLETED',
      input: { sourceJobId: jobId, planType: 'remediation' },
      output: plan,
      completedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  console.log('✅ Dummy remediation plan created!');
  console.log('   Plan Job ID:', planJob.id);
  console.log('   Tasks:', tasks.length);

  // Now force the workflow back to AUTO_REMEDIATION and trigger agent
  console.log('\n🔄 Moving workflow back to AUTO_REMEDIATION...');

  const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';
  await prisma.workflowInstance.update({
    where: { id: workflowId },
    data: {
      currentState: 'AUTO_REMEDIATION',
      errorMessage: null,
    }
  });

  console.log('✅ Workflow state updated');

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

createDummyPlan().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
