import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import {
  explanationCatalogService,
  ExplanationSource,
  IssueExplanation,
} from '../services/acr/explanation-catalog.service';
import { geminiService } from '../services/ai/gemini.service';

const PDF_CODE_PREFIXES = ['MATTERHORN-', 'PDF-', 'WCAG-'];

function isPdfCode(issueCode: string): boolean {
  return PDF_CODE_PREFIXES.some(p => issueCode.toUpperCase().startsWith(p));
}

async function buildGeminiGenerateFn(
  source: ExplanationSource
): Promise<((code: string, fixType: 'auto' | 'quickfix' | 'manual') => Promise<Partial<IssueExplanation>>) | undefined> {
  if (source === 'hardcoded') return undefined;

  return async (code: string, fixType: 'auto' | 'quickfix' | 'manual') => {
    const fixLabel = fixType === 'auto' ? 'automatically fixable' : fixType === 'quickfix' ? 'a guided quick-fix' : 'a manual fix requiring human judgment';

    const prompt = `You are an EPUB/PDF accessibility expert. Explain the following accessibility issue code to a publisher.

Issue code: ${code}
Fix type: ${fixLabel}

Respond in JSON with these exact keys:
- "reason": 1–2 sentences explaining WHY this issue is classified as "${fixType}" (not auto/quick/manual)
- "whatPlatformDid": if auto-fix, 1 sentence describing what the platform programmatically changed (or null if not auto)
- "whatUserMustDo": if quick/manual, 1–2 sentences describing what the user must do (or null if auto)
- "wcagGuidance": the relevant WCAG success criterion (e.g. "WCAG 2.1 SC 1.1.1 — Non-text Content")
- "estimatedTime": for manual/quick-fix only, a time estimate like "2–5 minutes per image" (or null)

Be concise, practical, and avoid jargon. Assume the user is a non-technical publisher.`;

    try {
      const response = await geminiService.generateText(prompt, {
        model: 'flash',
        temperature: 0.2,
        maxOutputTokens: 400,
      });

      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};

      return JSON.parse(jsonMatch[0]) as Partial<IssueExplanation>;
    } catch (err) {
      logger.warn(`[ExplanationController] Gemini generation failed for ${code}: ${err}`);
      return {};
    }
  };
}

class ExplanationController {
  /**
   * GET /api/v1/jobs/:jobId/issues/:issueCode/explanation
   * Returns an explanation for why an issue has its fix type and what can be done.
   */
  async getIssueExplanation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const { jobId, issueCode } = req.params;

      // Verify job belongs to tenant
      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId: req.user.tenantId },
        select: { id: true },
      });

      if (!job) throw AppError.notFound('Job not found');

      // Resolve tenant explanation source
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      const settings = (tenant?.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const reports = (settings.reports && typeof settings.reports === 'object')
        ? (settings.reports as Record<string, unknown>)
        : {};

      const source: ExplanationSource = (reports.explanationSource as ExplanationSource) ?? 'hardcoded';
      const geminiGenerateFn = await buildGeminiGenerateFn(source);

      const explanation = await explanationCatalogService.getExplanation(
        issueCode,
        source,
        isPdfCode(issueCode),
        geminiGenerateFn
      );

      res.json({ success: true, data: explanation });
    } catch (error) {
      next(error);
    }
  }
}

export const explanationController = new ExplanationController();
