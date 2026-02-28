/**
 * Plagiarism Check Service
 *
 * Detects content copied from external published sources using Claude AI.
 * Claude analyzes each text chunk against its knowledge of published literature,
 * academic papers, websites, and books to identify potential plagiarism.
 *
 * Pipeline:
 * 1. Parse document into chunks
 * 2. Send each chunk to Claude for external source analysis
 * 3. Claude identifies passages that match known published works
 * 4. Store results as PlagiarismMatch records
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { claudeService } from '../ai/claude.service';
import { splitTextIntoChunks } from '../../utils/text-chunker';

interface DetectedMatch {
  passageFromDocument: string;
  matchedSourceText: string;
  sourceName: string;
  sourceAuthors: string;
  sourceYear: string;
  sourceType: 'EXTERNAL_WEB' | 'EXTERNAL_ACADEMIC' | 'EXTERNAL_PUBLISHER';
  matchType: 'VERBATIM_COPY' | 'PARAPHRASED' | 'COMMON_PHRASE' | 'PROPERLY_CITED';
  similarityScore: number;
  confidence: number;
  reasoning: string;
}

const CHUNK_DELAY_MS = 500;

/**
 * Analyze a text chunk for content copied from external published sources.
 */
async function detectExternalPlagiarism(text: string, contentType?: string): Promise<DetectedMatch[]> {
  const prompt = `CONTENT TYPE: ${contentType || 'UNKNOWN'}

DOCUMENT TEXT:
<<<CONTENT_START>>>
${text}
<<<CONTENT_END>>>

Analyze this text for passages that appear to be copied, paraphrased, or closely derived from known published sources (academic papers, books, websites, articles).

For each potentially plagiarized passage found, return:
{
  "passageFromDocument": "exact text from the document that appears copied",
  "matchedSourceText": "the original text from the known published source",
  "sourceName": "title of the source publication/paper/book/website",
  "sourceAuthors": "author(s) of the source",
  "sourceYear": "year of publication or unknown",
  "sourceType": "EXTERNAL_ACADEMIC | EXTERNAL_PUBLISHER | EXTERNAL_WEB",
  "matchType": "VERBATIM_COPY | PARAPHRASED | COMMON_PHRASE | PROPERLY_CITED",
  "similarityScore": 0.0-1.0,
  "confidence": 0-100,
  "reasoning": "brief explanation"
}

IMPORTANT RULES:
- Only flag passages where you can identify a specific likely source.
- Do NOT flag original analysis, opinions, or standard methodology descriptions.
- Do NOT flag common academic phrases, standard section headers, author affiliations, reference list entries, or DOIs.
- DO flag direct quotes without attribution, paraphrased ideas without citation, and copied content.
- Focus on substantial matches (at least a full sentence), not individual words or common phrases.
- If the text properly cites its sources, mark those as PROPERLY_CITED.
- Be thorough but avoid false positives.

Return a JSON array. Return [] if no plagiarism detected.`;

  try {
    const matches = await claudeService.generateJSON<DetectedMatch[]>(prompt, {
      model: 'sonnet',
      temperature: 0.1,
      maxTokens: 8000,
      systemPrompt: 'You are a plagiarism detection expert for academic and educational publishers. Analyze documents against your knowledge of published literature. Return ONLY a valid JSON array.',
    });

    if (!Array.isArray(matches)) {
      logger.warn('[PlagiarismCheck] Claude returned non-array response');
      return [];
    }

    // Filter out low-confidence matches and common phrases
    return matches.filter(m =>
      m.confidence >= 30 &&
      m.matchType !== 'COMMON_PHRASE' &&
      m.passageFromDocument &&
      m.passageFromDocument.length >= 20
    );
  } catch (error) {
    logger.error('[PlagiarismCheck] Claude analysis failed', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Start a plagiarism check job.
 */
async function startCheck(
  tenantId: string,
  documentId: string
): Promise<{ jobId: string }> {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) throw AppError.notFound('Document not found');

  // Prevent duplicate concurrent jobs for the same document/tenant
  const existingJob = await prisma.plagiarismCheckJob.findFirst({
    where: { documentId, tenantId, status: { in: ['QUEUED', 'PROCESSING'] } },
    select: { id: true },
  });
  if (existingJob) {
    return { jobId: existingJob.id };
  }

  const job = await prisma.plagiarismCheckJob.create({
    data: {
      tenantId,
      documentId,
      status: 'QUEUED',
      progress: 0,
    },
  });

  // Execute asynchronously
  executeCheck(job.id, tenantId, documentId).catch(err => {
    logger.error(`[PlagiarismCheck] Job ${job.id} failed:`, err);
  });

  return { jobId: job.id };
}

/**
 * Execute the plagiarism check (called asynchronously).
 */
async function executeCheck(
  jobId: string,
  _tenantId: string,
  documentId: string
): Promise<void> {
  try {
    await prisma.plagiarismCheckJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    // Fetch document content and content type
    const [editorialDoc, docContent] = await Promise.all([
      prisma.editorialDocument.findUnique({
        where: { id: documentId },
        select: { contentType: true },
      }),
      prisma.editorialDocumentContent.findUnique({
        where: { documentId },
        select: { fullText: true },
      }),
    ]);

    const contentType = editorialDoc?.contentType || 'UNKNOWN';

    if (!docContent?.fullText) {
      await prisma.plagiarismCheckJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', metadata: { error: 'No document content found' } },
      });
      return;
    }

    const fullText = docContent.fullText;

    // Ensure text chunks exist in DB (needed for storing match references)
    let dbChunks = await prisma.editorialTextChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
    });

    if (dbChunks.length === 0) {
      // Create DB chunks (~500 words each, as expected by the schema)
      const words = fullText.split(/\s+/);
      const chunkSize = 500;
      const chunkData: Array<{
        documentId: string;
        chunkIndex: number;
        text: string;
        wordCount: number;
        startOffset: number;
        endOffset: number;
      }> = [];

      let offset = 0;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunkWords = words.slice(i, i + chunkSize);
        const chunkText = chunkWords.join(' ');
        chunkData.push({
          documentId,
          chunkIndex: Math.floor(i / chunkSize),
          text: chunkText,
          wordCount: chunkWords.length,
          startOffset: offset,
          endOffset: offset + chunkText.length,
        });
        offset += chunkText.length + 1;
      }

      await prisma.editorialTextChunk.createMany({ data: chunkData });
      dbChunks = await prisma.editorialTextChunk.findMany({
        where: { documentId },
        orderBy: { chunkIndex: 'asc' },
      });
    }

    // Split full text into larger AI chunks (20K paragraph boundaries)
    const aiChunks = splitTextIntoChunks(fullText);

    await prisma.plagiarismCheckJob.update({
      where: { id: jobId },
      data: { totalChunks: aiChunks.length, progress: 10 },
    });

    logger.info(`[PlagiarismCheck] Document split into ${aiChunks.length} AI chunk(s) for analysis`);

    // Analyze each AI chunk for external plagiarism using Claude
    const allMatchData: Array<{
      documentId: string;
      sourceChunkId: string;
      matchedChunkId: string;
      matchType: string;
      similarityScore: number;
      classification: string;
      confidence: number;
      aiReasoning: string;
      sourceText: string;
      matchedText: string;
      status: string;
    }> = [];
    const progressPerChunk = 80 / Math.max(aiChunks.length, 1);

    for (let i = 0; i < aiChunks.length; i++) {
      const aiChunk = aiChunks[i];

      logger.info(`[PlagiarismCheck] Analyzing chunk ${i + 1}/${aiChunks.length} (${aiChunk.text.length} chars)`);

      const detectedMatches = await detectExternalPlagiarism(aiChunk.text, contentType);

      for (const match of detectedMatches) {
        try {
          // Find the DB chunk that contains this match (for sourceChunkId)
          const passageOffset = fullText.indexOf(match.passageFromDocument, aiChunk.offset);
          const matchOffset = passageOffset >= 0 ? passageOffset : aiChunk.offset;
          const dbChunk = dbChunks.find(c => c.startOffset <= matchOffset && c.endOffset >= matchOffset) || dbChunks[0];

          const sourceDescription = [
            match.sourceName,
            match.sourceAuthors ? `by ${match.sourceAuthors}` : '',
            match.sourceYear && match.sourceYear !== 'unknown' ? `(${match.sourceYear})` : '',
          ].filter(Boolean).join(' ');

          const validSourceTypes = ['EXTERNAL_WEB', 'EXTERNAL_ACADEMIC', 'EXTERNAL_PUBLISHER'] as const;
          const sourceType = validSourceTypes.includes(match.sourceType as typeof validSourceTypes[number])
            ? match.sourceType
            : 'EXTERNAL_ACADEMIC';

          allMatchData.push({
            documentId,
            sourceChunkId: dbChunk.id,
            matchedChunkId: dbChunk.id,
            matchType: sourceType,
            similarityScore: match.similarityScore,
            classification: match.matchType,
            confidence: match.confidence,
            aiReasoning: match.reasoning,
            sourceText: match.passageFromDocument.slice(0, 2000),
            matchedText: `[${sourceDescription}]\n${match.matchedSourceText.slice(0, 1800)}`,
            status: 'PENDING',
          });
        } catch (err) {
          logger.warn('[PlagiarismCheck] Failed to prepare match:', err);
        }
      }

      // Update progress (throttled: every 3 chunks or on the last chunk)
      if ((i + 1) % 3 === 0 || i === aiChunks.length - 1) {
        const progress = Math.min(10 + Math.round((i + 1) * progressPerChunk), 95);
        await prisma.plagiarismCheckJob.update({
          where: { id: jobId },
          data: { progress, matchesFound: allMatchData.length },
        });
      }

      // Rate-limit delay between chunks
      if (i < aiChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }

    // Atomically replace old matches with new results
    await prisma.$transaction(async (tx) => {
      await tx.plagiarismMatch.deleteMany({ where: { documentId } });
      if (allMatchData.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tx.plagiarismMatch.createMany({ data: allMatchData as any });
      }
    });

    // Complete
    await prisma.plagiarismCheckJob.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        matchesFound: allMatchData.length,
        completedAt: new Date(),
      },
    });

    logger.info(`[PlagiarismCheck] Job ${jobId} completed: ${allMatchData.length} matches from external sources`);
  } catch (error) {
    logger.error(`[PlagiarismCheck] Job ${jobId} failed:`, error);
    await prisma.plagiarismCheckJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
      },
    }).catch(() => {});
  }
}

/**
 * Get job status (tenant-scoped).
 */
async function getJobStatus(jobId: string, tenantId: string) {
  return prisma.plagiarismCheckJob.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true,
      documentId: true,
      status: true,
      progress: true,
      totalChunks: true,
      matchesFound: true,
      startedAt: true,
      completedAt: true,
      metadata: true,
    },
  });
}

/**
 * Get matches for a document with filtering and pagination.
 */
async function getMatches(
  documentId: string,
  tenantId: string,
  options?: {
    matchType?: string;
    classification?: string;
    status?: string;
    page?: number;
    limit?: number;
  }
) {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) return { matches: [], total: 0, page: 1, limit: 50, totalPages: 0 };

  const page = options?.page ?? 1;
  const limit = options?.limit ?? 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { documentId };
  if (options?.matchType) where.matchType = options.matchType;
  if (options?.classification) where.classification = options.classification;
  if (options?.status) where.status = options.status;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedWhere = where as any;

  const [matches, total] = await Promise.all([
    prisma.plagiarismMatch.findMany({
      where: typedWhere,
      orderBy: [{ similarityScore: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.plagiarismMatch.count({
      where: typedWhere,
    }),
  ]);

  return { matches, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Get summary grouped by type, classification, and status.
 */
async function getSummary(documentId: string, tenantId: string) {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) return { total: 0, averageSimilarity: 0, byType: {}, byClassification: {}, byStatus: {} };

  // Use aggregation queries instead of loading all matches
  const [byTypeGroups, byClassificationGroups, byStatusGroups, aggregate] = await Promise.all([
    prisma.plagiarismMatch.groupBy({
      by: ['matchType'],
      where: { documentId },
      _count: true,
    }),
    prisma.plagiarismMatch.groupBy({
      by: ['classification'],
      where: { documentId },
      _count: true,
    }),
    prisma.plagiarismMatch.groupBy({
      by: ['status'],
      where: { documentId },
      _count: true,
    }),
    prisma.plagiarismMatch.aggregate({
      where: { documentId },
      _avg: { similarityScore: true },
      _count: true,
    }),
  ]);

  const byType: Record<string, number> = {};
  for (const g of byTypeGroups) byType[g.matchType] = g._count;
  const byClassification: Record<string, number> = {};
  for (const g of byClassificationGroups) byClassification[g.classification] = g._count;
  const byStatus: Record<string, number> = {};
  for (const g of byStatusGroups) byStatus[g.status] = g._count;

  return {
    total: aggregate._count,
    averageSimilarity: aggregate._avg.similarityScore ?? 0,
    byType,
    byClassification,
    byStatus,
  };
}

/**
 * Review a single match.
 */
async function reviewMatch(
  matchId: string,
  tenantId: string,
  status: 'CONFIRMED_PLAGIARISM' | 'FALSE_POSITIVE' | 'PROPERLY_ATTRIBUTED' | 'DISMISSED',
  reviewedBy: string,
  reviewNotes?: string
) {
  // Verify match belongs to a document owned by tenant
  const match = await prisma.plagiarismMatch.findFirst({
    where: { id: matchId, document: { tenantId } },
    select: { id: true },
  });
  if (!match) {
    throw AppError.notFound('Plagiarism match not found');
  }

  return prisma.plagiarismMatch.update({
    where: { id: matchId },
    data: {
      status,
      reviewedBy,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes || null,
    },
  });
}

/**
 * Bulk review multiple matches (tenant-scoped).
 */
async function bulkReview(
  matchIds: string[],
  tenantId: string,
  status: 'CONFIRMED_PLAGIARISM' | 'FALSE_POSITIVE' | 'PROPERLY_ATTRIBUTED' | 'DISMISSED',
  reviewedBy: string
) {
  const result = await prisma.plagiarismMatch.updateMany({
    where: { id: { in: matchIds }, document: { tenantId } },
    data: {
      status: status as 'CONFIRMED_PLAGIARISM' | 'FALSE_POSITIVE' | 'PROPERLY_ATTRIBUTED' | 'DISMISSED',
      reviewedBy,
      reviewedAt: new Date(),
    },
  });
  return { updated: result.count };
}

export const plagiarismCheckService = {
  startCheck,
  getJobStatus,
  getMatches,
  getSummary,
  reviewMatch,
  bulkReview,
};
