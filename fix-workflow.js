const { enqueueWorkflowEvent } = require('./dist/queues/workflow.queue');

(async () => {
  const workflowId = '16ddd924-0518-4521-90b7-af20b0a0b33e';
  console.log('Sending ACE_START event to unstick workflow...');
  
  await enqueueWorkflowEvent(workflowId, 'ACE_START');
  
  console.log('Event enqueued! Watch backend logs for processing.');
  process.exit(0);
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
