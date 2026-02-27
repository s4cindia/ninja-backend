import { Request } from 'express';

/** Type guard: true when auth middleware has populated req.user */
export function isAuthenticated(req: Request): req is Request & { user: { tenantId: string; id: string } } {
  return !!req.user && typeof (req.user as unknown as Record<string, unknown>).tenantId === 'string';
}
