import { Job } from '@prisma/client';

declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string;
      email: string;
      tenantId: string;
      role: string;
    }
    
    interface Request {
      user?: AuthenticatedUser;
      job?: Job;
    }
  }
}
