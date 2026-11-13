/**
 * notifyJobAssignment -- fires both the in-app JOB_ASSIGNED notification
 * and (per the user's explicit "Option 2" decision, matching the
 * feedback-submission-to-admin email precedent) an email to the
 * Executive a title was just assigned to. A no-op for the overwhelming
 * majority of uploads (plain self-uploads, where assignedById is null).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../src/services/notification/notification.service', () => ({
  notificationService: { createNotification: vi.fn() },
}));

vi.mock('../../../src/services/email/email.service', () => ({
  emailService: { sendJobAssignedEmail: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { notificationService } from '../../../src/services/notification/notification.service';
import { emailService } from '../../../src/services/email/email.service';
import { notifyJobAssignment } from '../../../src/controllers/pdf.controller';

/** Flushes the fire-and-forget async work notifyJobAssignment kicks off -- the function itself returns void synchronously. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('notifyJobAssignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (notificationService.createNotification as any).mockResolvedValue(undefined);
    (emailService.sendJobAssignedEmail as any).mockResolvedValue(undefined);
  });

  it('is a complete no-op for a normal self-upload (assignedById null)', async () => {
    notifyJobAssignment({ ownerId: 'caller-1', assignedById: null, assignedAt: null }, 'tenant-1', 'job-1', 'title.pdf');
    await flush();

    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(emailService.sendJobAssignedEmail).not.toHaveBeenCalled();
  });

  it('fires the in-app notification to the assignee with a status-agnostic link', async () => {
    (prisma.user.findUnique as any).mockResolvedValue(null);

    notifyJobAssignment({ ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() }, 'tenant-1', 'job-1', 'title.pdf');
    await flush();

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'exec-1',
        tenantId: 'tenant-1',
        type: 'JOB_ASSIGNED',
        link: '/pdf/audit/job-1',
      })
    );
  });

  it('sends the assignee an email with the assigner\'s name, once both user lookups resolve', async () => {
    (prisma.user.findUnique as any)
      .mockResolvedValueOnce({ email: 'exec@example.com', firstName: 'Ada', lastName: 'Lovelace' })
      .mockResolvedValueOnce({ firstName: 'Grace', lastName: 'Hopper' });

    notifyJobAssignment({ ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() }, 'tenant-1', 'job-1', 'title.pdf');
    await flush();

    expect(emailService.sendJobAssignedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeEmail: 'exec@example.com',
        assigneeName: 'Ada Lovelace',
        assignedByName: 'Grace Hopper',
        fileName: 'title.pdf',
      })
    );
  });

  it('skips the email (without throwing) when the assignee user record cannot be found', async () => {
    (prisma.user.findUnique as any).mockResolvedValue(null);

    notifyJobAssignment({ ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() }, 'tenant-1', 'job-1', 'title.pdf');
    await flush();

    expect(emailService.sendJobAssignedEmail).not.toHaveBeenCalled();
  });

  it('a failed email send never throws out of notifyJobAssignment (fire-and-forget, non-fatal)', async () => {
    (prisma.user.findUnique as any)
      .mockResolvedValueOnce({ email: 'exec@example.com', firstName: 'Ada', lastName: 'Lovelace' })
      .mockResolvedValueOnce(null);
    (emailService.sendJobAssignedEmail as any).mockRejectedValue(new Error('SMTP down'));

    expect(() =>
      notifyJobAssignment({ ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() }, 'tenant-1', 'job-1', 'title.pdf')
    ).not.toThrow();
    await flush();
  });

  it('a failed in-app notification create never blocks the email from still being sent', async () => {
    (notificationService.createNotification as any).mockRejectedValue(new Error('db down'));
    (prisma.user.findUnique as any)
      .mockResolvedValueOnce({ email: 'exec@example.com', firstName: 'Ada', lastName: 'Lovelace' })
      .mockResolvedValueOnce(null);

    notifyJobAssignment({ ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() }, 'tenant-1', 'job-1', 'title.pdf');
    await flush();

    expect(emailService.sendJobAssignedEmail).toHaveBeenCalledTimes(1);
  });
});
