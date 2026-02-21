const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const workflowId = '14ac8e1d-393a-4a70-beab-74798f3c2d61';

async function checkWorkflow() {
  const w = await prisma.workflowInstance.findUnique({
    where: { id: workflowId }
  });

  console.log('\n📊 Workflow Status:');
  console.log('  Current State:', w.currentState);
  console.log('  Completed:', w.completedAt ? 'YES' : 'NO');
  console.log('  Error:', w.errorMessage || 'none');

  const events = await prisma.workflowEvent.findMany({
    where: { workflowId },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`\n📜 Events (${events.length}):`);
  events.forEach((e, i) => {
    const time = new Date(e.timestamp).toISOString().substr(11, 8);
    console.log(`  ${i + 1}. [${time}] ${e.eventType}: ${e.fromState} → ${e.toState}`);
  });

  const stateData = w.stateData;
  if (stateData && typeof stateData === 'object') {
    console.log('\n💾 State Data:');
    console.log(`  JobID: ${stateData.jobId || 'none'}`);
    console.log(`  Audit Score: ${stateData.auditScore || 'N/A'}`);
    console.log(`  Issues: ${stateData.issueCount || 'N/A'}`);
  }

  await prisma.$disconnect();

  return w.currentState;
}

checkWorkflow().catch(console.error);
