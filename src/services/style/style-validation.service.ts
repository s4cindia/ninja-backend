/**
 * Style Validation Service
 *
 * Core orchestrator for style validation:
 * - Start validation jobs
 * - Get/filter violations
 * - Apply fixes (single and bulk)
 * - Ignore violations
 * - Generate validation summaries
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { styleRulesRegistry, type RuleMatch } from './style-rules-registry.service';
import { houseStyleEngine } from './house-style-engine.service';
import { editorialAi } from '../shared/editorial-ai-client';
import { citationStorageService } from '../citation/citation-storage.service';
import { documentExtractor } from '../document/document-extractor.service';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type {
  StyleValidationJob,
  StyleViolation,
  StyleCategory,
  StyleSeverity,
  StyleGuideType,
  ViolationStatus,
  JobStatus,
} from '@prisma/client';

export interface StartValidationInput {
  documentId: string;
  ruleSetIds: string[];
  styleGuide?: StyleGuideType;
  includeHouseRules?: boolean;
  useAiValidation?: boolean;
}

export interface ViolationFilters {
  category?: StyleCategory;
  severity?: StyleSeverity;
  status?: ViolationStatus;
  ruleId?: string;
  styleGuide?: StyleGuideType;
  search?: string;
}

export interface ApplyFixInput {
  violationId: string;
  fixOption: string;
  userId: string;
}

export interface BulkActionInput {
  violationIds: string[];
  action: 'fix' | 'ignore' | 'wont_fix';
  userId: string;
  reason?: string;
}

export interface BulkFixResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ violationId: string; error: string }>;
}

export interface ValidationSummary {
  jobId: string;
  documentId: string;
  status: JobStatus;
  progress: number;
  totalViolations: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  topRules: Array<{ ruleId: string; ruleName: string; count: number }>;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ValidationProgress {
  jobId: string;
  status: JobStatus;
  progress: number;
  violationsFound: number;
  currentPhase?: string;
}

export class StyleValidationService {
  /**
   * Start a new style validation job
   */
  async startValidation(
    tenantId: string,
    userId: string,
    input: StartValidationInput
  ): Promise<StyleValidationJob> {
    // Verify document exists
    const document = await prisma.editorialDocument.findUnique({
      where: { id: input.documentId },
      include: { documentContent: true },
    });

    if (!document) {
      throw AppError.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
    }

    // If no text content, try to extract it from the document file
    let fullText = document.documentContent?.fullText;

    if (!fullText && document.storagePath && document.storageType) {
      logger.info(`[Style Validation] No text content found, attempting extraction for document ${input.documentId}`);

      try {
        // Get the document file from storage
        const fileBuffer = await citationStorageService.getFileBuffer(
          document.storagePath,
          document.storageType as 'S3' | 'LOCAL'
        );

        if (fileBuffer) {
          // Determine file extension from original name or storage path
          const originalName = document.originalName || document.storagePath;
          const ext = originalName.toLowerCase().endsWith('.pdf') ? '.pdf' : '.docx';
          const tempPath = path.join(os.tmpdir(), `style-extract-${input.documentId}${ext}`);
          fs.writeFileSync(tempPath, fileBuffer);

          try {
            // Extract text
            const extracted = await documentExtractor.extract(tempPath);
            fullText = extracted.text;

            // Update the document content in the database
            if (document.documentContent) {
              await prisma.editorialDocumentContent.update({
                where: { documentId: input.documentId },
                data: {
                  fullText: fullText,
                  wordCount: fullText.split(/\s+/).length,
                },
              });
            } else {
              await prisma.editorialDocumentContent.create({
                data: {
                  documentId: input.documentId,
                  fullText: fullText,
                  wordCount: fullText.split(/\s+/).length,
                },
              });
            }

            logger.info(`[Style Validation] Extracted ${fullText.length} characters from document ${input.documentId}`);
          } finally {
            // Clean up temp file
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
          }
        }
      } catch (error) {
        logger.warn(`[Style Validation] Text extraction failed for document ${input.documentId}:`, error);
      }
    }

    if (!fullText) {
      throw AppError.badRequest(
        'Document has no text content to validate. Please ensure the document has been saved.',
        'NO_CONTENT'
      );
    }

    // Count total rules
    let totalRules = 0;
    for (const ruleSetId of input.ruleSetIds) {
      const ruleSet = styleRulesRegistry.getRuleSet(ruleSetId);
      if (ruleSet) {
        totalRules += ruleSet.rules.length;
      }
    }

    // Add house rules if requested
    if (input.includeHouseRules) {
      const houseRules = await houseStyleEngine.getActiveRules(tenantId);
      totalRules += houseRules.length;
    }

    // Create the job
    const job = await prisma.styleValidationJob.create({
      data: {
        tenantId,
        documentId: input.documentId,
        status: 'QUEUED',
        ruleSetIds: input.ruleSetIds,
        totalRules,
        createdBy: userId,
      },
    });

    logger.info(
      `[Style Validation] Created job ${job.id} for document ${input.documentId} with ${totalRules} rules`
    );

    return job;
  }

  /**
   * Execute validation (called by job processor)
   */
  async executeValidation(
    jobId: string,
    onProgress?: (progress: number, message: string) => Promise<void>
  ): Promise<number> {
    const job = await prisma.styleValidationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw AppError.notFound('Validation job not found', 'JOB_NOT_FOUND');
    }

    // Get document content
    const document = await prisma.editorialDocument.findUnique({
      where: { id: job.documentId },
      include: { documentContent: true },
    });

    if (!document?.documentContent?.fullText) {
      throw AppError.internal('Document content not found');
    }

    const text = document.documentContent.fullText;

    // Update job to processing
    await prisma.styleValidationJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    let totalViolations = 0;
    const allMatches: RuleMatch[] = [];

    try {
      // Phase 1: Execute built-in rules (0-50%)
      await onProgress?.(5, 'Starting rule-based validation');

      const builtInMatches = styleRulesRegistry.validateText(
        text,
        job.ruleSetIds,
        { fullText: text, documentTitle: document.title ?? undefined }
      );
      allMatches.push(...builtInMatches);

      await onProgress?.(30, `Found ${builtInMatches.length} rule-based matches`);

      // Phase 2: Execute house rules from selected rule sets (50-70%)
      // Get rules from selected custom rule sets (not just all active rules)
      const selectedCustomRuleSetIds = job.ruleSetIds.filter(id =>
        !['general', 'academic', 'chicago', 'apa', 'mla', 'ap', 'vancouver', 'nature', 'ieee'].includes(id)
      );

      let houseRules: Awaited<ReturnType<typeof houseStyleEngine.getActiveRules>> = [];

      if (selectedCustomRuleSetIds.length > 0) {
        // Get rules from specifically selected custom rule sets
        houseRules = await houseStyleEngine.getRulesFromSets(job.tenantId, selectedCustomRuleSetIds);
        logger.info(`[Style Validation] Found ${houseRules.length} rules from ${selectedCustomRuleSetIds.length} selected custom rule sets`);
      } else {
        // Fall back to all active house rules if no custom sets selected
        houseRules = await houseStyleEngine.getActiveRules(job.tenantId);
      }

      if (houseRules.length > 0) {
        await onProgress?.(35, `Checking ${houseRules.length} house rules`);

        const houseMatches = await houseStyleEngine.executeHouseRulesAsync(
          houseRules,
          text
        );
        allMatches.push(...houseMatches);

        await onProgress?.(50, `Found ${houseMatches.length} house rule matches`);
      }

      // Phase 3: AI validation (70-90%)
      const styleGuide = this.determineStyleGuide(job.ruleSetIds);
      logger.info(`[Style Validation] Starting AI validation with style guide: ${styleGuide}, rule sets: ${job.ruleSetIds.join(', ')}`);
      await onProgress?.(55, `Running AI-powered ${styleGuide.toUpperCase()} validation`);

      try {
        // Build comprehensive custom rules text for AI
        const customRulesForAI: string[] = [];

        // Add house rule descriptions for AI context
        for (const rule of houseRules) {
          const ruleDesc = rule.description
            ? `${rule.name}: ${rule.description}`
            : rule.name;
          customRulesForAI.push(ruleDesc);

          // Add avoid terms if it's a terminology rule
          if (rule.avoidTerms && rule.avoidTerms.length > 0) {
            customRulesForAI.push(`Avoid: ${(rule.avoidTerms as string[]).join(', ')} → Use: ${rule.preferredTerm || 'alternative'}`);
          }
        }

        logger.info(`[Style Validation] Sending ${customRulesForAI.length} custom rules to AI for validation`);

        const aiViolations = await editorialAi.validateStyle(
          text,
          styleGuide,
          customRulesForAI.length > 0 ? customRulesForAI : undefined
        );

        logger.info(`[Style Validation] AI returned ${aiViolations.length} violations`);

        // Convert AI violations to RuleMatch format
        for (const v of aiViolations) {
          allMatches.push({
            startOffset: v.location.start,
            endOffset: v.location.end,
            lineNumber: v.location.lineNumber,
            matchedText: v.originalText,
            suggestedFix: v.suggestedFix,
            ruleId: `ai-${v.rule.toLowerCase().replace(/\s+/g, '-')}`,
            ruleName: v.rule,
            ruleReference: v.ruleReference,
            description: v.explanation || `${v.ruleReference}: ${v.originalText} → ${v.suggestedFix}`,
            explanation: v.explanation,
          });
        }

        await onProgress?.(80, `AI found ${aiViolations.length} additional issues`);
      } catch (aiError) {
        logger.error('[Style Validation] AI validation failed:', aiError);
        await onProgress?.(80, 'AI validation failed - using rule-based results only');
      }

      // Phase 4: Store violations (90-100%)
      await onProgress?.(85, 'Storing violations');

      // Deduplicate and sort
      const uniqueMatches = this.deduplicateMatches(allMatches);

      // Store violations in database
      for (const match of uniqueMatches) {
        await prisma.styleViolation.create({
          data: {
            documentId: job.documentId,
            jobId: job.id,
            styleGuide: this.getStyleGuideFromRuleSet(job.ruleSetIds),
            ruleId: match.ruleId,
            ruleReference: match.ruleReference || null,
            category: this.inferCategory(match.ruleId),
            severity: this.inferSeverityFromMatch(match),
            title: match.ruleName,
            description: match.description,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            paragraphIndex: match.lineNumber, // Store line number as paragraph index
            originalText: match.matchedText,
            suggestedText: match.suggestedFix || null,
            status: 'PENDING',
          },
        });
        totalViolations++;
      }

      // Update job status
      await prisma.styleValidationJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          violationsFound: totalViolations,
          completedAt: new Date(),
        },
      });

      await onProgress?.(100, `Validation complete: ${totalViolations} violations found`);

      logger.info(
        `[Style Validation] Job ${jobId} completed with ${totalViolations} violations`
      );

      return totalViolations;
    } catch (error) {
      // Update job to failed
      await prisma.styleValidationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown error',
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }

  /**
   * Get violations for a document
   */
  async getViolations(
    documentId: string,
    filters?: ViolationFilters,
    pagination?: { skip?: number; take?: number }
  ): Promise<{ violations: StyleViolation[]; total: number }> {
    const where: Record<string, unknown> = { documentId };

    if (filters?.category) where.category = filters.category;
    if (filters?.severity) where.severity = filters.severity;
    if (filters?.status) where.status = filters.status;
    if (filters?.ruleId) where.ruleId = filters.ruleId;
    if (filters?.styleGuide) where.styleGuide = filters.styleGuide;

    if (filters?.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
        { originalText: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [violations, total] = await Promise.all([
      prisma.styleViolation.findMany({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: where as any,
        orderBy: [{ severity: 'asc' }, { startOffset: 'asc' }],
        skip: pagination?.skip || 0,
        take: pagination?.take || 100,
      }),
      prisma.styleViolation.count({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: where as any,
      }),
    ]);

    return { violations, total };
  }

  /**
   * Get a single violation by ID
   */
  async getViolation(violationId: string): Promise<StyleViolation | null> {
    return prisma.styleViolation.findUnique({
      where: { id: violationId },
    });
  }

  /**
   * Apply a fix to a violation
   */
  async applyFix(input: ApplyFixInput): Promise<StyleViolation> {
    const violation = await prisma.styleViolation.findUnique({
      where: { id: input.violationId },
    });

    if (!violation) {
      throw AppError.notFound('Violation not found', 'VIOLATION_NOT_FOUND');
    }

    if (violation.status !== 'PENDING') {
      throw AppError.badRequest(
        `Violation is already ${violation.status.toLowerCase()}`,
        'ALREADY_RESOLVED'
      );
    }

    // Update the violation
    const updated = await prisma.styleViolation.update({
      where: { id: input.violationId },
      data: {
        status: 'FIXED',
        appliedFix: input.fixOption,
        fixedAt: new Date(),
        fixedBy: input.userId,
        resolvedBy: input.userId,
        resolvedAt: new Date(),
      },
    });

    logger.info(`[Style Validation] Applied fix to violation ${input.violationId}`);

    return updated;
  }

  /**
   * Ignore a violation
   */
  async ignoreViolation(
    violationId: string,
    userId: string,
    reason?: string
  ): Promise<StyleViolation> {
    const violation = await prisma.styleViolation.findUnique({
      where: { id: violationId },
    });

    if (!violation) {
      throw AppError.notFound('Violation not found', 'VIOLATION_NOT_FOUND');
    }

    if (violation.status !== 'PENDING') {
      throw AppError.badRequest(
        `Violation is already ${violation.status.toLowerCase()}`,
        'ALREADY_RESOLVED'
      );
    }

    const updated = await prisma.styleViolation.update({
      where: { id: violationId },
      data: {
        status: 'IGNORED',
        ignoredReason: reason || null,
        resolvedBy: userId,
        resolvedAt: new Date(),
      },
    });

    logger.info(`[Style Validation] Ignored violation ${violationId}`);

    return updated;
  }

  /**
   * Mark a violation as won't fix
   */
  async markWontFix(
    violationId: string,
    userId: string,
    reason?: string
  ): Promise<StyleViolation> {
    const violation = await prisma.styleViolation.findUnique({
      where: { id: violationId },
    });

    if (!violation) {
      throw AppError.notFound('Violation not found', 'VIOLATION_NOT_FOUND');
    }

    const updated = await prisma.styleViolation.update({
      where: { id: violationId },
      data: {
        status: 'WONT_FIX',
        ignoredReason: reason || null,
        resolvedBy: userId,
        resolvedAt: new Date(),
      },
    });

    logger.info(`[Style Validation] Marked violation ${violationId} as won't fix`);

    return updated;
  }

  /**
   * Bulk fix/ignore violations
   */
  async bulkAction(input: BulkActionInput): Promise<BulkFixResult> {
    const result: BulkFixResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    for (const violationId of input.violationIds) {
      result.processed++;

      try {
        switch (input.action) {
          case 'fix': {
            const violation = await this.getViolation(violationId);
            if (violation?.suggestedText) {
              await this.applyFix({
                violationId,
                fixOption: violation.suggestedText,
                userId: input.userId,
              });
              result.succeeded++;
            } else {
              result.failed++;
              result.errors.push({
                violationId,
                error: 'No suggested fix available',
              });
            }
            break;
          }

          case 'ignore':
            await this.ignoreViolation(violationId, input.userId, input.reason);
            result.succeeded++;
            break;

          case 'wont_fix':
            await this.markWontFix(violationId, input.userId, input.reason);
            result.succeeded++;
            break;
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          violationId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info(
      `[Style Validation] Bulk ${input.action}: ${result.succeeded}/${result.processed} succeeded`
    );

    return result;
  }

  /**
   * Get validation summary for a document
   */
  async getValidationSummary(documentId: string): Promise<ValidationSummary | null> {
    // Get the latest job for this document
    const job = await prisma.styleValidationJob.findFirst({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) {
      return null;
    }

    // Get violation counts by category
    const categoryGroups = await prisma.styleViolation.groupBy({
      by: ['category'],
      where: { documentId, jobId: job.id },
      _count: { category: true },
    });

    // Get violation counts by severity
    const severityGroups = await prisma.styleViolation.groupBy({
      by: ['severity'],
      where: { documentId, jobId: job.id },
      _count: { severity: true },
    });

    // Get violation counts by status
    const statusGroups = await prisma.styleViolation.groupBy({
      by: ['status'],
      where: { documentId, jobId: job.id },
      _count: { status: true },
    });

    // Get top rules
    const ruleGroups = await prisma.styleViolation.groupBy({
      by: ['ruleId', 'title'],
      where: { documentId, jobId: job.id },
      _count: { ruleId: true },
      orderBy: { _count: { ruleId: 'desc' } },
      take: 10,
    });

    const totalViolations = await prisma.styleViolation.count({
      where: { documentId, jobId: job.id },
    });

    return {
      jobId: job.id,
      documentId,
      status: job.status,
      progress: job.progress,
      totalViolations,
      byCategory: Object.fromEntries(
        categoryGroups.map(g => [g.category, g._count.category])
      ),
      bySeverity: Object.fromEntries(
        severityGroups.map(g => [g.severity, g._count.severity])
      ),
      byStatus: Object.fromEntries(
        statusGroups.map(g => [g.status, g._count.status])
      ),
      topRules: ruleGroups.map(g => ({
        ruleId: g.ruleId || 'unknown',
        ruleName: g.title,
        count: g._count.ruleId,
      })),
      startedAt: job.startedAt ?? undefined,
      completedAt: job.completedAt ?? undefined,
    };
  }

  /**
   * Get job progress
   */
  async getJobProgress(jobId: string): Promise<ValidationProgress | null> {
    const job = await prisma.styleValidationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return null;
    }

    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      violationsFound: job.violationsFound,
    };
  }

  /**
   * Update job progress in database
   */
  async updateJobProgress(jobId: string, progress: number, currentPhase: string): Promise<void> {
    await prisma.styleValidationJob.update({
      where: { id: jobId },
      data: {
        progress,
        // Store current phase in a way that can be retrieved (using error field temporarily)
        // or just log it since the main purpose is to update progress
      },
    });
    logger.debug(`[Style Validation] Job ${jobId} progress: ${progress}% - ${currentPhase}`);
  }

  // Helper methods

  private determineStyleGuide(ruleSetIds: string[]): 'chicago' | 'apa' | 'mla' | 'vancouver' | 'custom' {
    if (ruleSetIds.includes('chicago')) return 'chicago';
    if (ruleSetIds.includes('apa')) return 'apa';
    if (ruleSetIds.includes('mla')) return 'mla';
    if (ruleSetIds.includes('vancouver')) return 'vancouver';
    return 'custom';
  }

  private getStyleGuideFromRuleSet(ruleSetIds: string[]): StyleGuideType {
    if (ruleSetIds.includes('chicago')) return 'CHICAGO';
    if (ruleSetIds.includes('apa')) return 'APA';
    if (ruleSetIds.includes('mla')) return 'MLA';
    if (ruleSetIds.includes('nature')) return 'NATURE';
    if (ruleSetIds.includes('ieee')) return 'IEEE';
    return 'CUSTOM';
  }

  private inferCategory(ruleId: string): StyleCategory {
    if (ruleId.startsWith('punct-')) return 'PUNCTUATION';
    if (ruleId.startsWith('cap-')) return 'CAPITALIZATION';
    if (ruleId.startsWith('num-')) return 'NUMBERS';
    if (ruleId.startsWith('abbr-')) return 'ABBREVIATIONS';
    if (ruleId.startsWith('gram-')) return 'GRAMMAR';
    if (ruleId.startsWith('term-')) return 'TERMINOLOGY';
    if (ruleId.startsWith('ai-')) return 'OTHER';
    return 'OTHER';
  }

  private inferSeverity(ruleId: string): StyleSeverity {
    // Critical rules
    if (
      ruleId.includes('sentence-start') ||
      ruleId.includes('subject-verb')
    ) {
      return 'ERROR';
    }

    // Suggestions
    if (
      ruleId.includes('passive') ||
      ruleId.includes('very') ||
      ruleId.includes('utilize')
    ) {
      return 'SUGGESTION';
    }

    // Default to warning
    return 'WARNING';
  }

  private inferSeverityFromMatch(match: RuleMatch): StyleSeverity {
    // If the match has explicit severity info from AI (in description/explanation)
    if (match.description?.toLowerCase().includes('error') ||
        match.explanation?.toLowerCase().includes('must fix')) {
      return 'ERROR';
    }

    if (match.description?.toLowerCase().includes('suggestion') ||
        match.explanation?.toLowerCase().includes('consider')) {
      return 'SUGGESTION';
    }

    // For AI-detected rules, try to infer from the rule name
    if (match.ruleId.startsWith('ai-')) {
      const ruleLower = match.ruleName.toLowerCase();
      // Grammar and punctuation errors are usually more severe
      if (ruleLower.includes('error') || ruleLower.includes('incorrect') ||
          ruleLower.includes('missing') || ruleLower.includes('required')) {
        return 'ERROR';
      }
      if (ruleLower.includes('consider') || ruleLower.includes('prefer') ||
          ruleLower.includes('suggestion') || ruleLower.includes('optional')) {
        return 'SUGGESTION';
      }
    }

    // Fall back to rule-based inference
    return this.inferSeverity(match.ruleId);
  }

  private deduplicateMatches(matches: RuleMatch[]): RuleMatch[] {
    const seen = new Set<string>();
    const unique: RuleMatch[] = [];

    for (const match of matches) {
      const key = `${match.startOffset}-${match.endOffset}-${match.ruleId}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(match);
      }
    }

    return unique.sort((a, b) => a.startOffset - b.startOffset);
  }
}

export const styleValidation = new StyleValidationService();
