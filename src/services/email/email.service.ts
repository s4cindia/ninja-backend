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
      });
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
    const failedRow = data.filesFailed > 0
      ? `<div class="stat-row">
          <span class="stat-label">Failed</span>
          <span class="stat-value error">${data.filesFailed}</span>
        </div>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
    .stats { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { font-weight: 600; color: #6b7280; }
    .stat-value { font-weight: 700; color: #111827; }
    .stat-value.success { color: #10b981; }
    .stat-value.warning { color: #f59e0b; }
    .stat-value.error { color: #ef4444; }
    .cta-button { display: inline-block; background: #667eea; color: white !important; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin: 0;">Batch Processing Complete</h1>
  </div>
  <div class="content">
    <p>Hi ${data.userName},</p>
    <p>Your batch <strong>"${data.batchName}"</strong> has completed processing successfully!</p>
    <div class="stats">
      <h3 style="margin-top: 0;">Processing Summary</h3>
      <div class="stat-row">
        <span class="stat-label">Total Files</span>
        <span class="stat-value">${data.totalFiles}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Successfully Processed</span>
        <span class="stat-value success">${data.filesSuccessful}</span>
      </div>
      ${failedRow}
      <div class="stat-row">
        <span class="stat-label">Issues Found</span>
        <span class="stat-value">${data.totalIssues}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Auto-Fixed</span>
        <span class="stat-value success">${data.autoFixed}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Quick-Fixes Needed</span>
        <span class="stat-value warning">${data.quickFixes}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Manual Fixes Needed</span>
        <span class="stat-value">${data.manualFixes}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Processing Time</span>
        <span class="stat-value">${data.processingTime}</span>
      </div>
    </div>
    <p style="text-align: center;">
      <a href="${data.resultsUrl}" class="cta-button">View Results &amp; Download Files</a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      You can now generate ACR/VPAT reports, export your files, or apply quick-fixes.
    </p>
  </div>
  <div class="footer">
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

  private buildFailureHtml(data: BatchFailureEmailData): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #ef4444; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
    .error-box { background: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 6px; margin: 20px 0; color: #991b1b; }
    .cta-button { display: inline-block; background: #667eea; color: white !important; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin: 0;">Batch Processing Failed</h1>
  </div>
  <div class="content">
    <p>Hi ${data.userName},</p>
    <p>Unfortunately, your batch <strong>"${data.batchName}"</strong> encountered an error during processing.</p>
    <div class="error-box">
      <strong>Error:</strong> ${data.errorMessage}
    </div>
    <p>Please review the batch details and try again. If the problem persists, contact support.</p>
    <p style="text-align: center;">
      <a href="${data.resultsUrl}" class="cta-button">View Batch Details</a>
    </p>
  </div>
  <div class="footer">
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
