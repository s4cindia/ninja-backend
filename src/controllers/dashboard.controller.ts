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

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    success: true,
    data: stats
  });
};

export const getDashboardActivity = async (_req: Request, res: Response) => {
  const activities: Array<{
    id: string;
    type: string;
    description: string;
    timestamp: string;
  }> = [];

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    success: true,
    data: activities
  });
};
