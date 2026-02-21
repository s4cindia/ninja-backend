const { enqueueWorkflowEvent } = require('./dist/queues/workflow.queue');

async function main() {
  const workflowId = 'e6fb1251-081f-47ef-8cc9-e58e0cb6d876';
  
  console.log(`Manually triggering PREPROCESS event for workflow ${workflowId}`);
  
  await enqueueWorkflowEvent(workflowId, 'PREPROCESS');
  
  console.log('Event enqueued successfully! Check backend logs for processing.');
  
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
