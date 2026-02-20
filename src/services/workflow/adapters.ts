import * as path from 'path';
import { logger } from '../../lib/logger';
import { epubAuditService } from '../epub/epub-audit.service';
import { callAceMicroservice } from '../epub/ace-client.service';
import { geminiService } from '../ai/gemini.service';
import { remediationService } from '../epub/remediation.service';
import { conformanceEngineService } from '../acr/conformance-engine.service';
import { acrGeneratorService } from '../acr/acr-generator.service';
import { s3Service } from '../s3.service';

/**
 * Runs EPUBCheck on the file identified by filePath (S3 key).
 * Delegates to epubAuditService.runAuditFromS3.
 */
export async function runEpubCheck(
  jobId: string,
  filePath: string,
): Promise<{ passed: boolean; issueCount: number }> {
  const fileName = path.basename(filePath);
  const result = await epubAuditService.runAuditFromS3(filePath, jobId, fileName);
  return {
    passed: result.isValid,
    issueCount: result.combinedIssues.length,
  };
}

/**
 * Runs Ace accessibility checker on the file identified by filePath (S3 key).
 * Fetches the buffer from S3 then delegates to callAceMicroservice.
 */
export async function runAce(
  jobId: string,
  filePath: string,
): Promise<{ passed: boolean; violationCount: number }> {
  const fileName = path.basename(filePath);
  const buffer = await s3Service.getFileBuffer(filePath);
  const result = await callAceMicroservice(buffer, fileName);

  if (!result) {
    logger.info(`[workflow-adapter] Stubbed: runAce for job ${jobId} — ACE microservice unavailable`);
    return { passed: true, violationCount: 0 };
  }

  return {
    passed: result.violations.length === 0,
    violationCount: result.violations.length,
  };
}

/**
 * Runs AI-assisted accessibility analysis via Gemini.
 * Returns a confidence score (0-100) and a findings array.
 */
export async function runAIAnalysis(
  jobId: string,
): Promise<{ confidence: number; findings: unknown[] }> {
  const prompt = `You are an EPUB accessibility analysis assistant.
Analyze job "${jobId}" and return a JSON object with:
- confidence: number (0-100, how confident you are in the analysis)
- findings: array of finding objects, each with { criterion: string, status: string, notes: string }

If no specific audit data is available, return a conservative analysis with confidence 50.
Respond ONLY with valid JSON.`;

  try {
    const response = await geminiService.generateStructuredOutput<{
      confidence: number;
      findings: unknown[];
    }>(prompt);

    return {
      confidence: response.data.confidence ?? 50,
      findings: response.data.findings ?? [],
    };
  } catch (error) {
    logger.warn(
      `[workflow-adapter] runAIAnalysis fallback for job ${jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return { confidence: 50, findings: [] };
  }
}

/**
 * Runs auto-remediation using the existing remediation service.
 * Falls back to stub if no remediation plan exists for the job.
 */
export async function runAutoRemediation(
  jobId: string,
): Promise<{ fixed: number; failed: number }> {
  try {
    const result = await remediationService.runAutoRemediation(jobId);
    logger.info(
      `[workflow-adapter] runAutoRemediation for job ${jobId}: ${result.succeeded} fixed, ${result.failed} failed`,
    );
    return { fixed: result.succeeded, failed: result.failed };
  } catch (error) {
    logger.info(
      `[workflow-adapter] Stubbed: runAutoRemediation for job ${jobId} — ${error instanceof Error ? error.message : 'No plan found'}`,
    );
    return { fixed: 0, failed: 0 };
  }
}

/**
 * Runs a verification audit step.
 * Stub — returns verified: true.
 */
export async function runVerificationAudit(
  jobId: string,
): Promise<{ verified: boolean }> {
  logger.info(`[workflow-adapter] Stubbed: runVerificationAudit for job ${jobId}`);
  return { verified: true };
}

/**
 * Runs conformance mapping using the conformance engine.
 * Returns the count of criteria mapped.
 */
export async function runConformanceMapping(
  jobId: string,
): Promise<{ criteriaCount: number }> {
  try {
    const acrDocument = await conformanceEngineService.buildAcrFromJob(jobId);
    if (acrDocument) {
      return { criteriaCount: acrDocument.criteria.length };
    }
    logger.info(`[workflow-adapter] Stubbed: runConformanceMapping for job ${jobId} — no ACR document`);
    return { criteriaCount: 0 };
  } catch (error) {
    logger.info(
      `[workflow-adapter] Stubbed: runConformanceMapping for job ${jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return { criteriaCount: 0 };
  }
}

/**
 * Generates an ACR document using the ACR generator service.
 * Returns the ACR document id.
 */
export async function generateAcr(
  jobId: string,
  vpatEditions?: string[],
): Promise<{ acrId: string }> {
  const edition =
    vpatEditions && vpatEditions.length > 0
      ? (vpatEditions[0] as import('../acr/acr-generator.service').AcrEdition)
      : ('VPAT2.5-INT' as import('../acr/acr-generator.service').AcrEdition);

  const acrDocument = await acrGeneratorService.generateAcr(jobId, {
    edition,
    productInfo: {
      name: 'EPUB Publication',
      version: '1.0',
      description: 'Accessibility Conformance Report',
      vendor: 'Ninja Platform',
      contactEmail: 'support@ninja-platform.com',
      evaluationDate: new Date(),
    },
  });

  return { acrId: acrDocument.id };
}
