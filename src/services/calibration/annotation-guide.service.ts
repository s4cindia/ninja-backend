/**
 * Annotation Guide Service.
 * Generates per-page markdown annotation guides using AI,
 * providing annotator training material based on zone data.
 */
import prisma from '../../lib/prisma';
import { geminiService } from '../ai/gemini.service';
import { logger } from '../../lib/logger';

interface PageGuide {
  pageNumber: number;
  title: string;
  zoneCount: number;
  markdown: string;
}

export interface AnnotationGuideResult {
  calibrationRunId: string;
  documentName: string;
  pages: PageGuide[];
  totalPages: number;
  generatedAt: string;
}

export async function generateAnnotationGuide(
  calibrationRunId: string,
): Promise<AnnotationGuideResult> {
  const run = await prisma.calibrationRun.findUnique({
    where: { id: calibrationRunId },
    select: {
      corpusDocument: { select: { filename: true, pageCount: true } },
    },
  });

  if (!run) throw new Error(`CalibrationRun ${calibrationRunId} not found`);

  const zones = await prisma.zone.findMany({
    where: { calibrationRunId, isGhost: false },
    select: {
      id: true,
      pageNumber: true,
      type: true,
      label: true,
      content: true,
      source: true,
      reconciliationBucket: true,
      bounds: true,
      decision: true,
      operatorLabel: true,
      aiLabel: true,
      aiConfidence: true,
      aiDecision: true,
    },
    orderBy: [{ pageNumber: 'asc' }, { id: 'asc' }],
  });

  // Group by page
  const byPage = new Map<number, typeof zones>();
  for (const z of zones) {
    if (!byPage.has(z.pageNumber)) byPage.set(z.pageNumber, []);
    byPage.get(z.pageNumber)!.push(z);
  }

  const totalPages = run.corpusDocument?.pageCount ?? byPage.size;
  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

  // Process pages in batches of 5 to avoid rate limits
  const pages: PageGuide[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < sortedPages.length; i += BATCH_SIZE) {
    const batch = sortedPages.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (pageNum) => {
        const pageZones = byPage.get(pageNum)!;
        try {
          return await generatePageGuide(pageNum, totalPages, pageZones);
        } catch (err) {
          logger.warn(`[annotation-guide] Failed to generate guide for page ${pageNum}: ${(err as Error).message}`);
          return {
            pageNumber: pageNum,
            title: `Page ${pageNum}`,
            zoneCount: pageZones.length,
            markdown: `## Page ${pageNum}\n\n*Guide generation failed. ${pageZones.length} zones on this page.*`,
          };
        }
      }),
    );
    pages.push(...batchResults);
  }

  return {
    calibrationRunId,
    documentName: run.corpusDocument?.filename ?? 'Unknown',
    pages,
    totalPages,
    generatedAt: new Date().toISOString(),
  };
}

async function generatePageGuide(
  pageNumber: number,
  totalPages: number,
  zones: Array<{
    id: string;
    type: string;
    label: string | null;
    content: string | null;
    source: string | null;
    reconciliationBucket: string | null;
    bounds: unknown;
    decision: string | null;
    operatorLabel: string | null;
    aiLabel: string | null;
    aiConfidence: number | null;
    aiDecision: string | null;
  }>,
): Promise<PageGuide> {
  const zonesSummary = zones.map((z, idx) => ({
    num: idx + 1,
    type: z.type,
    bucket: z.reconciliationBucket,
    source: z.source,
    content: z.content ? z.content.substring(0, 150) : null,
    aiLabel: z.aiLabel,
    aiConf: z.aiConfidence,
    decision: z.decision,
    operatorLabel: z.operatorLabel,
  }));

  const prompt = `You are creating an annotation training guide for PDF accessibility operators.

## Context
Page ${pageNumber} of ${totalPages}. ${pageNumber <= 2 ? 'This is front matter (title page, TOC).' : pageNumber >= totalPages - 1 ? 'This is back matter.' : 'This is body content.'}

## Zones on this page
\`\`\`json
${JSON.stringify(zonesSummary, null, 2)}
\`\`\`

## Task
Generate a markdown guide for this page with:
1. A short title describing the page content (e.g., "Chapter 1 — Introduction")
2. A brief description of what this page contains and any tricky classification decisions
3. A table of zones with columns: #, Type, Recommended Label, Confidence, Notes
4. For each zone, explain WHY that label is correct, especially for non-obvious cases
5. Highlight common pitfalls (e.g., "This looks like a paragraph but is actually a list item because...")

Keep it concise and actionable. Use markdown formatting. Do NOT wrap in code blocks.`;

  const response = await geminiService.generateText(prompt, { temperature: 0.3 });

  // Extract title from first heading
  const titleMatch = response.text.match(/^#+\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : `Page ${pageNumber}`;

  return {
    pageNumber,
    title,
    zoneCount: zones.length,
    markdown: response.text,
  };
}
