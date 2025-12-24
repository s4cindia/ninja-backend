import FormData from 'form-data';
import { logger } from '../../lib/logger';

interface AceViolation {
  rule: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  wcag?: string[];
  location?: string;
  html?: string;
}

interface AceResult {
  score: number;
  violations: AceViolation[];
  metadata: {
    conformsTo: string[];
    accessMode: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
    accessibilitySummary?: string;
  };
  outlines: {
    toc: unknown[];
    headings: unknown[];
  };
}

interface AceMicroserviceViolation {
  ruleId: string;
  impact: string;
  description: string;
  wcagCriteria?: string[];
  location?: string;
  html?: string;
}

interface AceMicroserviceResponse {
  success: boolean;
  data?: {
    score: number;
    violations: AceMicroserviceViolation[];
    metadata: {
      conformsTo?: string[];
      accessMode?: string[];
      accessibilityFeature?: string[];
      accessibilityHazard?: string[];
      accessibilitySummary?: string;
    };
    outlines?: {
      toc?: unknown[];
      headings?: unknown[];
    };
  };
  error?: string;
}

export async function callAceMicroservice(epubBuffer: Buffer, fileName: string): Promise<AceResult | null> {
  const aceServiceUrl = process.env.ACE_SERVICE_URL;

  if (!aceServiceUrl) {
    logger.info('[ACE Client] ACE_SERVICE_URL not configured, skipping');
    return null;
  }

  logger.info(`[ACE Client] Starting audit for ${fileName}`);

  try {
    const formData = new FormData();
    formData.append('epub', epubBuffer, {
      filename: fileName,
      contentType: 'application/epub+zip',
    });

    const result = await new Promise<AceMicroserviceResponse>((resolve, reject) => {
      formData.submit(`${aceServiceUrl}/audit`, (err, res) => {
        if (err) {
          reject(err);
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer | string) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      });
    });

    if (!result.success || !result.data) {
      logger.warn(`[ACE Client] Audit failed: ${result.error || 'Unknown error'}`);
      return null;
    }

    const aceResult: AceResult = {
      score: result.data.score,
      violations: result.data.violations.map((v) => ({
        rule: v.ruleId,
        impact: v.impact as AceViolation['impact'],
        description: v.description,
        wcag: v.wcagCriteria,
        location: v.location,
        html: v.html,
      })),
      metadata: {
        conformsTo: result.data.metadata.conformsTo || [],
        accessMode: result.data.metadata.accessMode || [],
        accessibilityFeature: result.data.metadata.accessibilityFeature || [],
        accessibilityHazard: result.data.metadata.accessibilityHazard || [],
        accessibilitySummary: result.data.metadata.accessibilitySummary,
      },
      outlines: {
        toc: result.data.outlines?.toc || [],
        headings: result.data.outlines?.headings || [],
      },
    };

    logger.info(`[ACE Client] Audit completed for ${fileName} - Score: ${aceResult.score}`);
    return aceResult;
  } catch (error) {
    logger.warn(`[ACE Client] Failed to call ACE microservice: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}
