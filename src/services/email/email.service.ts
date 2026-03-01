import nodemailer from 'nodemailer';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../../lib/logger';

interface BatchCompletionEmailData {
  userName: string;
  userEmail: string;
  batchName: string;
  batchId: string;
  totalFiles: number;
  filesSuccessful: number;
  filesFailed: number;
  totalIssues: number;
  autoFixed: number;
  quickFixes: number;
  manualFixes: number;
  processingTime: string;
  resultsUrl: string;
}

interface BatchFailureEmailData {
  userName: string;
  userEmail: string;
  batchName: string;
  batchId: string;
  errorMessage: string;
  resultsUrl: string;
}

interface BatchHITLEmailData {
  userName: string;
  userEmail: string;
  batchName: string;
  batchId: string;
  gateName: string;
  waitingCount: number;
  reviewUrl: string;
}

class EmailService {
  private transporter: nodemailer.Transporter;
  private from: string;

  constructor() {
    this.from = process.env.SMTP_FROM || 'noreply@ninja-platform.com';
    const provider = process.env.EMAIL_PROVIDER || 'smtp';

    if (provider === 'ses') {
      const ses = new SESClient({
        region: process.env.SES_REGION || 'us-east-1',
      });
      this.transporter = nodemailer.createTransport({
        SES: { ses, aws: { SendRawEmailCommand } },
      } as Parameters<typeof nodemailer.createTransport>[0]);
      logger.info('[Email] Using AWS SES transport');
    } else {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      });
      logger.info('[Email] Using SMTP transport');
    }
  }

  async sendBatchCompletionEmail(data: BatchCompletionEmailData): Promise<void> {
    await this.transporter.sendMail({
      from: `"Ninja Platform" <${this.from}>`,
      to: data.userEmail,
      subject: `Batch Processing Complete - ${data.batchName}`,
      text: this.buildCompletionText(data),
      html: this.buildCompletionHtml(data),
    });
    logger.info(`[Email] Batch completion email sent to ${data.userEmail} for batch ${data.batchId}`);
  }

  async sendBatchHITLEmail(data: BatchHITLEmailData): Promise<void> {
    await this.transporter.sendMail({
      from: `"Ninja Platform" <${this.from}>`,
      to: data.userEmail,
      subject: `Action Required: ${data.gateName} - ${data.batchName}`,
      text: this.buildHITLText(data),
      html: this.buildHITLHtml(data),
    });
    logger.info(`[Email] HITL gate email sent to ${data.userEmail} for batch ${data.batchId} (${data.gateName})`);
  }

  async sendBatchFailureEmail(data: BatchFailureEmailData): Promise<void> {
    await this.transporter.sendMail({
      from: `"Ninja Platform" <${this.from}>`,
      to: data.userEmail,
      subject: `Batch Processing Failed - ${data.batchName}`,
      text: this.buildFailureText(data),
      html: this.buildFailureHtml(data),
    });
    logger.info(`[Email] Batch failure email sent to ${data.userEmail} for batch ${data.batchId}`);
  }

  private buildCompletionHtml(data: BatchCompletionEmailData): string {
    const TD_LABEL = 'style="padding: 10px 0; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb;"';
    const TD_VALUE = 'style="padding: 10px 0; font-weight: 700; color: #111827; text-align: right; border-bottom: 1px solid #e5e7eb;"';
    const TD_SUCCESS = 'style="padding: 10px 0; font-weight: 700; color: #10b981; text-align: right; border-bottom: 1px solid #e5e7eb;"';
    const TD_WARNING = 'style="padding: 10px 0; font-weight: 700; color: #f59e0b; text-align: right; border-bottom: 1px solid #e5e7eb;"';
    const TD_ERROR = 'style="padding: 10px 0; font-weight: 700; color: #ef4444; text-align: right; border-bottom: 1px solid #e5e7eb;"';
    const TD_LABEL_LAST = 'style="padding: 10px 0; font-weight: 600; color: #6b7280;"';
    const TD_VALUE_LAST = 'style="padding: 10px 0; font-weight: 700; color: #111827; text-align: right;"';

    const failedRow = data.filesFailed > 0
      ? `<tr><td ${TD_LABEL}>Failed</td><td ${TD_ERROR}>${data.filesFailed}</td></tr>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">Batch Processing Complete</h1>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi ${data.userName},</p>
    <p>Your batch <strong>"${data.batchName}"</strong> has completed processing successfully!</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <h3 style="margin-top: 0; color: #111827;">Processing Summary</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td ${TD_LABEL}>Total Files</td><td ${TD_VALUE}>${data.totalFiles}</td></tr>
        <tr><td ${TD_LABEL}>Successfully Processed</td><td ${TD_SUCCESS}>${data.filesSuccessful}</td></tr>
        ${failedRow}
        <tr><td ${TD_LABEL}>Issues Found</td><td ${TD_VALUE}>${data.totalIssues}</td></tr>
        <tr><td ${TD_LABEL}>Auto-Fixed</td><td ${TD_SUCCESS}>${data.autoFixed}</td></tr>
        <tr><td ${TD_LABEL}>Quick-Fixes Needed</td><td ${TD_WARNING}>${data.quickFixes}</td></tr>
        <tr><td ${TD_LABEL}>Manual Fixes Needed</td><td ${TD_VALUE}>${data.manualFixes}</td></tr>
        <tr><td ${TD_LABEL_LAST}>Processing Time</td><td ${TD_VALUE_LAST}>${data.processingTime}</td></tr>
      </table>
    </div>
    <p style="text-align: center;">
      <a href="${data.resultsUrl}" style="display: inline-block; background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">View Results &amp; Download Files</a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      You can now generate ACR/VPAT reports, export your files, or apply quick-fixes.
    </p>
  </div>
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 14px;">
    <p>This is an automated notification from Ninja Platform.</p>
  </div>
</body>
</html>`;
  }

  private buildCompletionText(data: BatchCompletionEmailData): string {
    return `Batch Processing Complete

Hi ${data.userName},

Your batch "${data.batchName}" has completed processing successfully!

Processing Summary:
- Total Files: ${data.totalFiles}
- Successfully Processed: ${data.filesSuccessful}${data.filesFailed > 0 ? `\n- Failed: ${data.filesFailed}` : ''}
- Issues Found: ${data.totalIssues}
- Auto-Fixed: ${data.autoFixed}
- Quick-Fixes Needed: ${data.quickFixes}
- Manual Fixes Needed: ${data.manualFixes}
- Processing Time: ${data.processingTime}

View Results: ${data.resultsUrl}

You can now generate ACR/VPAT reports, export your files, or apply quick-fixes.

---
This is an automated notification from Ninja Platform.`;
  }

  private buildHITLHtml(data: BatchHITLEmailData): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">Action Required</h1>
    <p style="margin: 8px 0 0;">${data.gateName}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi ${data.userName},</p>
    <p>Your batch <strong>"${data.batchName}"</strong> has paused and is waiting for your review at the <strong>${data.gateName}</strong> gate.</p>
    <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 15px; border-radius: 6px; margin: 20px 0; color: #92400e; text-align: center;">
      <div style="font-size: 2em; font-weight: 700; color: #d97706;">${data.waitingCount}</div>
      <div>file(s) waiting for ${data.gateName}</div>
    </div>
    <p>Please log in to review and approve to continue processing.</p>
    <p style="text-align: center;">
      <a href="${data.reviewUrl}" style="display: inline-block; background: #f59e0b; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Review Now</a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      Processing will remain paused until you complete this review step.
    </p>
  </div>
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 14px;">
    <p>This is an automated notification from Ninja Platform.</p>
  </div>
</body>
</html>`;
  }

  private buildHITLText(data: BatchHITLEmailData): string {
    return `Action Required: ${data.gateName}

Hi ${data.userName},

Your batch "${data.batchName}" has paused at the ${data.gateName} gate.

${data.waitingCount} file(s) are waiting for your review.

Please log in to review and approve to continue processing.

Review Now: ${data.reviewUrl}

Processing will remain paused until you complete this review step.

---
This is an automated notification from Ninja Platform.`;
  }

  private buildFailureHtml(data: BatchFailureEmailData): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #ef4444; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">Batch Processing Failed</h1>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi ${data.userName},</p>
    <p>Unfortunately, your batch <strong>"${data.batchName}"</strong> encountered an error during processing.</p>
    <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 6px; margin: 20px 0; color: #991b1b;">
      <strong>Error:</strong> ${data.errorMessage}
    </div>
    <p>Please review the batch details and try again. If the problem persists, contact support.</p>
    <p style="text-align: center;">
      <a href="${data.resultsUrl}" style="display: inline-block; background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">View Batch Details</a>
    </p>
  </div>
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 14px;">
    <p>This is an automated notification from Ninja Platform.</p>
  </div>
</body>
</html>`;
  }

  private buildFailureText(data: BatchFailureEmailData): string {
    return `Batch Processing Failed

Hi ${data.userName},

Unfortunately, your batch "${data.batchName}" encountered an error during processing.

Error: ${data.errorMessage}

View Batch Details: ${data.resultsUrl}

Please review the batch and try again. If the problem persists, contact support.

---
This is an automated notification from Ninja Platform.`;
  }
}

export const emailService = new EmailService();
