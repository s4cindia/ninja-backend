import { Job } from 'bullmq';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';

export async function processFileJob(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { type } = job.data;

  switch (type) {
    case JOB_TYPES.ALT_TEXT_GENERATION:
      return await processAltTextGeneration(job);

    case JOB_TYPES.METADATA_EXTRACTION:
      return await processMetadataExtraction(job);

    default:
      throw new Error(`Unknown file job type: ${type}`);
  }
}

async function processAltTextGeneration(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  const stages = [
    { progress: 20, message: 'Extracting images from document' },
    { progress: 50, message: 'Generating alt text with AI' },
    { progress: 80, message: 'Validating generated text' },
    { progress: 100, message: 'Alt text generation complete' },
  ];

  for (const stage of stages) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await job.updateProgress(stage.progress);
    await queueService.updateJobProgress(jobId, stage.progress);
  }

  return {
    success: true,
    data: {
      type: 'ALT_TEXT_GENERATION',
      imagesProcessed: 5,
      altTextsGenerated: 5,
      timestamp: new Date().toISOString(),
    },
  };
}

async function processMetadataExtraction(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  const stages = [
    { progress: 25, message: 'Reading document structure' },
    { progress: 50, message: 'Extracting metadata fields' },
    { progress: 75, message: 'Validating metadata' },
    { progress: 100, message: 'Metadata extraction complete' },
  ];

  for (const stage of stages) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await job.updateProgress(stage.progress);
    await queueService.updateJobProgress(jobId, stage.progress);
  }

  return {
    success: true,
    data: {
      type: 'METADATA_EXTRACTION',
      metadata: {
        title: 'Sample Document',
        author: 'Unknown',
        language: 'en',
        pageCount: 10,
      },
      timestamp: new Date().toISOString(),
    },
  };
}
