import prisma from '../lib/prisma';

export const authorizeJobAccess = async (jobId: string, userId: string) => {
  const job = await prisma.job.findFirst({
    where: { 
      id: jobId,
      userId: userId 
    },
  });
  
  if (!job) {
    throw new Error('Job not found or access denied');
  }
  
  return job;
};
