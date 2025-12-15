import { Request, Response } from 'express';

export const getDashboardStats = async (_req: Request, res: Response) => {
  const stats = {
    totalFiles: 0,
    filesProcessed: 0,
    filesPending: 0,
    filesFailed: 0,
    averageComplianceScore: 0,
    recentActivity: []
  };

  res.json(stats);
};
