require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const jobId = 'cc081e1d-20ee-4e39-929b-cafcc2dae799';

async function findPlanJob() {
  console.log('🔍 Looking for BATCH_VALIDATION job...');

  const planJob = await prisma.job.findFirst({
    where: {
      type: 'BATCH_VALIDATION',
      input: {
        path: ['sourceJobId'],
        equals: jobId,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (planJob) {
    console.log('✅ Found plan job!');
    console.log('   Job ID:', planJob.id);
    console.log('   Status:', planJob.status);
    console.log('   Created:', planJob.createdAt);
    console.log('\n   Output:', JSON.stringify(planJob.output, null, 2).substring(0, 500));
  } else {
    console.log('❌ No remediation plan job found');
    console.log('\n💡 The workflow needs to create a remediation plan first.');
    console.log('   Usually this happens during the AI analysis phase.');
    console.log('   Since this is a workflow test, we should either:');
    console.log('   1. Create a dummy remediation plan, OR');
    console.log('   2. Skip remediation for this test');
  }

  await prisma.$disconnect();
}

findPlanJob().catch(console.error);
