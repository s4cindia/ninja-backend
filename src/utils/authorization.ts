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

export const authorizeJobAccessOptional = async (jobId: string, userId?: string) => {
  const whereClause: { id: string; userId?: string } = { id: jobId };
  
  if (userId) {
    whereClause.userId = userId;
  }

  const job = await prisma.job.findFirst({
    where: whereClause,
  });
  
  if (!job) {
    throw new Error('Job not found or access denied');
  }
  
  return job;
};
