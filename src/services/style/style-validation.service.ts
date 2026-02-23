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
import { nanoid } from 'nanoid';
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
  tenantId: string;
}

export interface BulkActionInput {
  violationIds: string[];
  action: 'fix' | 'ignore' | 'wont_fix';
  userId: string;
  tenantId: string;
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
  fileName?: string;
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
    // Verify document exists and belongs to tenant
    const document = await prisma.editorialDocument.findFirst({
      where: { id: input.documentId, tenantId },
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
          const lowerName = originalName.toLowerCase();
          let ext = '.docx'; // default
          if (lowerName.endsWith('.pdf')) ext = '.pdf';
          else if (lowerName.endsWith('.doc')) ext = '.doc';
          else if (lowerName.endsWith('.docx')) ext = '.docx';
          else if (lowerName.endsWith('.txt')) ext = '.txt';
          else if (lowerName.endsWith('.rtf')) ext = '.rtf';
          const tempPath = path.join(os.tmpdir(), `style-extract-${input.documentId}-${nanoid(8)}${ext}`);
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

    // Helper to update both StyleValidationJob progress and call external callback
    const updateProgress = async (progress: number, message: string) => {
      await prisma.styleValidationJob.update({
        where: { id: jobId },
        data: { progress },
      });
      await onProgress?.(progress, message);
    };

    try {
      // Skip built-in regex rules - use AI validation only for quality results
      // Built-in rules generate too many false positives and slow down validation
      await updateProgress(5, 'Starting AI-powered validation');

      // Get custom house rules for AI context (but don't run regex matching on them)
      logger.info(`[Style Validation] Job ruleSetIds: ${JSON.stringify(job.ruleSetIds)}`);

      const selectedCustomRuleSetIds = job.ruleSetIds.filter(id =>
        !['general', 'academic', 'chicago', 'apa', 'mla', 'ap', 'vancouver', 'nature', 'ieee'].includes(id)
      );

      logger.info(`[Style Validation] Custom rule set IDs after filtering: ${JSON.stringify(selectedCustomRuleSetIds)}`);

      let houseRules: Awaited<ReturnType<typeof houseStyleEngine.getActiveRules>> = [];

      if (selectedCustomRuleSetIds.length > 0) {
        houseRules = await houseStyleEngine.getRulesFromSets(job.tenantId, selectedCustomRuleSetIds);
        logger.info(`[Style Validation] Found ${houseRules.length} custom rules from DB: ${houseRules.map(r => r.name).join(', ')}`);
      } else {
        logger.info(`[Style Validation] No custom rule sets selected - using style guide rules only`);
      }

      await updateProgress(10, 'Preparing AI validation');

      // AI validation (main phase - 10-90%)
      const styleGuide = this.determineStyleGuide(job.ruleSetIds);
      logger.info(`[Style Validation] Starting AI validation with style guide: ${styleGuide}, rule sets: ${job.ruleSetIds.join(', ')}`);
      await updateProgress(55, `Running AI-powered ${styleGuide.toUpperCase()} validation`);

      try {
        // Build comprehensive custom rules text for AI
        const customRulesForAI: string[] = [];

        // Add house rule descriptions for AI context
        for (const rule of houseRules) {
          let ruleText = `[${rule.category}] ${rule.name}`;

          if (rule.description) {
            ruleText += `: ${rule.description}`;
          }

          // Add preferred term info for terminology rules
          if (rule.ruleType === 'TERMINOLOGY' && rule.preferredTerm) {
            ruleText += ` REQUIRED TERM: "${rule.preferredTerm}" - Flag any variations or alternative phrasings.`;
          }

          // Add avoid terms if specified
          if (rule.avoidTerms && (rule.avoidTerms as string[]).length > 0) {
            ruleText += ` AVOID: ${(rule.avoidTerms as string[]).join(', ')}`;
            if (rule.preferredTerm) {
              ruleText += ` → USE: "${rule.preferredTerm}"`;
            }
          }

          // Add pattern info if available
          if (rule.pattern) {
            ruleText += ` PATTERN: ${rule.pattern}`;
          }

          customRulesForAI.push(ruleText);
        }

        logger.info(`[Style Validation] Sending ${customRulesForAI.length} custom rules to AI: ${customRulesForAI.join(' | ')}`);

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
            source: 'AI',
          });
        }

        await updateProgress(80, `AI found ${aiViolations.length} additional issues`);
      } catch (aiError) {
        logger.error('[Style Validation] AI validation failed:', aiError);
        await updateProgress(80, 'AI validation failed - using rule-based results only');
      }

      // Phase 4: Store violations (90-100%)
      await updateProgress(85, 'Storing violations');

      // Clear previous violations for this document
      await prisma.styleViolation.deleteMany({
        where: { documentId: job.documentId },
      });
      logger.info(`[Style Validation] Cleared old violations for document ${job.documentId}`);

      // Deduplicate and sort
      const uniqueMatches = this.deduplicateMatches(allMatches);

      // Store violations in database using batch insert for performance
      const violationData = uniqueMatches
        .map(match => ({
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
          status: 'PENDING' as const,
          source: (match.source || 'BUILT_IN') as 'AI' | 'BUILT_IN' | 'HOUSE',
        }))
        // Filter out violations where original and suggested text are identical
        .filter(v => {
          if (!v.suggestedText) return true; // Keep if no suggestion
          const original = v.originalText?.trim() || '';
          const suggested = v.suggestedText.trim();
          return original !== suggested; // Only keep if they differ
        });

      if (violationData.length > 0) {
        await prisma.styleViolation.createMany({ data: violationData });
      }
      totalViolations = violationData.length;

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

      await updateProgress(100, `Validation complete: ${totalViolations} violations found`);

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
    tenantId: string,
    filters?: ViolationFilters,
    pagination?: { skip?: number; take?: number }
  ): Promise<{ violations: StyleViolation[]; total: number }> {
    // First verify the document belongs to the tenant
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId },
      select: { id: true },
    });

    if (!document) {
      throw AppError.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
    }

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
  async getViolation(violationId: string, tenantId: string): Promise<StyleViolation | null> {
    // Verify tenant ownership via document relation to prevent IDOR
    return prisma.styleViolation.findFirst({
      where: {
        id: violationId,
        document: { tenantId },
      },
    });
  }

  /**
   * Apply a fix to a violation
   */
  async applyFix(input: ApplyFixInput): Promise<StyleViolation> {
    // Find violation and verify tenant ownership via document
    const violation = await prisma.styleViolation.findFirst({
      where: {
        id: input.violationId,
        document: { tenantId: input.tenantId },
      },
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
    tenantId: string,
    userId: string,
    reason?: string
  ): Promise<StyleViolation> {
    // Find violation and verify tenant ownership via document
    const violation = await prisma.styleViolation.findFirst({
      where: {
        id: violationId,
        document: { tenantId },
      },
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
    tenantId: string,
    userId: string,
    reason?: string
  ): Promise<StyleViolation> {
    // Find violation and verify tenant ownership via document
    const violation = await prisma.styleViolation.findFirst({
      where: {
        id: violationId,
        document: { tenantId },
      },
    });

    if (!violation) {
      throw AppError.notFound('Violation not found', 'VIOLATION_NOT_FOUND');
    }

    // Check if already resolved for consistency with other methods
    if (violation.status !== 'PENDING') {
      throw AppError.badRequest(
        `Violation is already ${violation.status.toLowerCase()}`,
        'ALREADY_RESOLVED'
      );
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
      processed: input.violationIds.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    // For ignore and wont_fix, use batch update for better performance
    if (input.action === 'ignore' || input.action === 'wont_fix') {
      const status = input.action === 'ignore' ? 'IGNORED' : 'WONT_FIX';

      // Verify all violations belong to the tenant before updating
      const validViolations = await prisma.styleViolation.findMany({
        where: {
          id: { in: input.violationIds },
          status: 'PENDING',
          document: { tenantId: input.tenantId },
        },
        select: { id: true },
      });

      const validIds = validViolations.map(v => v.id);
      const invalidIds = input.violationIds.filter(id => !validIds.includes(id));

      // Add errors for invalid violations
      for (const id of invalidIds) {
        result.failed++;
        result.errors.push({
          violationId: id,
          error: 'Violation not found or already resolved',
        });
      }

      // Batch update valid violations
      if (validIds.length > 0) {
        const updateResult = await prisma.styleViolation.updateMany({
          where: { id: { in: validIds } },
          data: {
            status,
            ignoredReason: input.reason || null,
            resolvedBy: input.userId,
            resolvedAt: new Date(),
          },
        });
        result.succeeded = updateResult.count;
      }
    } else {
      // For 'fix' action, we need to process individually since each has different suggested text
      for (const violationId of input.violationIds) {
        try {
          const violation = await prisma.styleViolation.findFirst({
            where: {
              id: violationId,
              document: { tenantId: input.tenantId },
            },
          });

          if (!violation) {
            result.failed++;
            result.errors.push({ violationId, error: 'Violation not found' });
            continue;
          }

          if (violation.suggestedText) {
            await this.applyFix({
              violationId,
              fixOption: violation.suggestedText,
              userId: input.userId,
              tenantId: input.tenantId,
            });
            result.succeeded++;
          } else {
            result.failed++;
            result.errors.push({
              violationId,
              error: 'No suggested fix available',
            });
          }
        } catch (error) {
          result.failed++;
          result.errors.push({
            violationId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
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
  async getValidationSummary(documentId: string, tenantId: string): Promise<ValidationSummary | null> {
    // Verify document belongs to tenant and get file name
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId },
      select: { id: true, fileName: true, originalName: true },
    });

    if (!document) {
      throw AppError.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
    }

    // Get the latest job for this document
    const job = await prisma.styleValidationJob.findFirst({
      where: { documentId, tenantId },
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
      fileName: document.originalName || document.fileName,
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
  async getJobProgress(jobId: string, tenantId: string): Promise<ValidationProgress | null> {
    const job = await prisma.styleValidationJob.findFirst({
      where: { id: jobId, tenantId },
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

  private determineStyleGuide(ruleSetIds: string[]): 'chicago' | 'apa' | 'mla' | 'vancouver' | 'nature' | 'ieee' | 'ap' | 'general' | 'academic' | 'custom' {
    // Check for specific style guides in priority order
    if (ruleSetIds.includes('chicago')) return 'chicago';
    if (ruleSetIds.includes('apa')) return 'apa';
    if (ruleSetIds.includes('mla')) return 'mla';
    if (ruleSetIds.includes('vancouver')) return 'vancouver';
    if (ruleSetIds.includes('nature')) return 'nature';
    if (ruleSetIds.includes('ieee')) return 'ieee';
    if (ruleSetIds.includes('ap')) return 'ap';
    if (ruleSetIds.includes('academic')) return 'academic';
    if (ruleSetIds.includes('general')) return 'general';
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
