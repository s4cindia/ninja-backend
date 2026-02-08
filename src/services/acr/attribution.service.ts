import { VerificationStatus } from './human-verification.service';

export type AttributionTag = 
  | 'AUTOMATED'       
  | 'AI_SUGGESTED'    
  | 'HUMAN_VERIFIED'; 

export interface AttributedFinding {
  findingId: string;
  attributionTag: AttributionTag;
  automatedToolVersion: string;
  aiModelUsed?: string;
  humanVerifier?: string;
  verificationMethod?: string;
  originalRemark?: string;
  attributedRemark: string;
}

export interface Tool {
  name: string;
  version: string;
  purpose: string;
}

export interface AiModel {
  name: string;
  provider: string;
  purpose: string;
}

export interface Reviewer {
  id: string;
  role: string;
  verificationCount: number;
}

export interface MethodologySection {
  assessmentDate: Date;
  toolsUsed: Tool[];
  aiModelsUsed: AiModel[];
  humanReviewers: Reviewer[];
  disclaimer: string;
  summary: {
    totalFindings: number;
    automatedFindings: number;
    aiSuggestedFindings: number;
    humanVerifiedFindings: number;
  };
}

export const TOOL_VERSION = 'Ninja Platform v1.0';

export const AI_MODEL_INFO: AiModel = {
  name: 'Google Gemini',
  provider: 'Google',
  purpose: 'Alt text suggestions, remediation guidance, content analysis'
};

export const LEGAL_DISCLAIMER = `
This Accessibility Conformance Report was generated using automated testing tools 
supplemented by AI-assisted analysis. Automated tools can detect approximately 
30-57% of accessibility barriers. Items marked [AI-SUGGESTED] require human 
verification for accuracy. This report should be reviewed by qualified 
accessibility professionals before use in procurement decisions.

Assessment Tool: ${TOOL_VERSION}
AI Model: Google Gemini (for alt text suggestions and remediation guidance)
`.trim();

export const ATTRIBUTION_MARKERS = {
  AUTOMATED: '[AUTOMATED]',
  AI_SUGGESTED: '[AI-SUGGESTED]',
  HUMAN_VERIFIED: '[HUMAN-VERIFIED]'
} as const;

export function determineAttributionTag(
  verificationStatus?: VerificationStatus,
  isAiGenerated?: boolean
): AttributionTag {
  if (verificationStatus === 'VERIFIED_PASS' || 
      verificationStatus === 'VERIFIED_FAIL' || 
      verificationStatus === 'VERIFIED_PARTIAL') {
    return 'HUMAN_VERIFIED';
  }
  
  if (isAiGenerated) {
    return 'AI_SUGGESTED';
  }
  
  return 'AUTOMATED';
}

export function formatAttributedRemark(
  originalRemark: string,
  attributionTag: AttributionTag,
  isAltTextSuggestion: boolean = false
): string {
  const marker = ATTRIBUTION_MARKERS[attributionTag];
  
  if (isAltTextSuggestion && attributionTag === 'AI_SUGGESTED') {
    return `${marker} AI-Suggested - Requires Review: ${originalRemark}`;
  }
  
  return `${marker} ${originalRemark}`;
}

export function attributeFinding(
  findingId: string,
  originalRemark: string,
  verificationStatus?: VerificationStatus,
  isAiGenerated: boolean = false,
  isAltTextSuggestion: boolean = false,
  humanVerifier?: string,
  verificationMethod?: string
): AttributedFinding {
  const attributionTag = determineAttributionTag(verificationStatus, isAiGenerated);
  
  return {
    findingId,
    attributionTag,
    automatedToolVersion: TOOL_VERSION,
    aiModelUsed: isAiGenerated ? AI_MODEL_INFO.name : undefined,
    humanVerifier,
    verificationMethod,
    originalRemark,
    attributedRemark: formatAttributedRemark(originalRemark, attributionTag, isAltTextSuggestion)
  };
}

interface VerificationRecord {
  itemId: string;
  status: VerificationStatus;
  verifiedBy?: string;
  method?: string;
}

interface FindingMetadata {
  findingId: string;
  isAiGenerated: boolean;
  isAltTextSuggestion: boolean;
}

export function generateMethodologySection(
  findings: FindingMetadata[],
  verificationRecords: VerificationRecord[]
): MethodologySection {
  const verificationMap = new Map(
    verificationRecords.map(r => [r.itemId, r])
  );
  
  let automatedCount = 0;
  let aiSuggestedCount = 0;
  let humanVerifiedCount = 0;
  
  const reviewerMap = new Map<string, { count: number; role: string }>();
  
  for (const finding of findings) {
    const verification = verificationMap.get(finding.findingId);
    const tag = determineAttributionTag(verification?.status, finding.isAiGenerated);
    
    switch (tag) {
      case 'AUTOMATED':
        automatedCount++;
        break;
      case 'AI_SUGGESTED':
        aiSuggestedCount++;
        break;
      case 'HUMAN_VERIFIED':
        humanVerifiedCount++;
        if (verification?.verifiedBy) {
          const existing = reviewerMap.get(verification.verifiedBy);
          if (existing) {
            existing.count++;
          } else {
            reviewerMap.set(verification.verifiedBy, { 
              count: 1, 
              role: 'Accessibility Specialist' 
            });
          }
        }
        break;
    }
  }
  
  const humanReviewers: Reviewer[] = Array.from(reviewerMap.entries()).map(
    ([id, data]) => ({
      id,
      role: data.role,
      verificationCount: data.count
    })
  );
  
  const toolsUsed: Tool[] = [
    {
      name: 'Ninja Platform',
      version: '1.0',
      purpose: 'Automated accessibility validation against WCAG 2.1, Section 508, and PDF/UA standards'
    },
    {
      name: 'pdf-lib',
      version: '1.17.1',
      purpose: 'PDF structure parsing and metadata extraction'
    },
    {
      name: 'pdfjs-dist',
      version: '4.0.269',
      purpose: 'PDF text and content extraction'
    }
  ];
  
  const aiModelsUsed: AiModel[] = aiSuggestedCount > 0 ? [AI_MODEL_INFO] : [];
  
  return {
    assessmentDate: new Date(),
    toolsUsed,
    aiModelsUsed,
    humanReviewers,
    disclaimer: LEGAL_DISCLAIMER,
    summary: {
      totalFindings: findings.length,
      automatedFindings: automatedCount,
      aiSuggestedFindings: aiSuggestedCount,
      humanVerifiedFindings: humanVerifiedCount
    }
  };
}

export function generateMethodologyText(methodology: MethodologySection): string {
  const sections: string[] = [];
  
  sections.push('# Assessment Methodology');
  sections.push('');
  sections.push(`**Assessment Date:** ${methodology.assessmentDate.toISOString().split('T')[0]}`);
  sections.push('');
  
  sections.push('## Tools Used');
  for (const tool of methodology.toolsUsed) {
    sections.push(`- **${tool.name} ${tool.version}:** ${tool.purpose}`);
  }
  sections.push('');
  
  if (methodology.aiModelsUsed.length > 0) {
    sections.push('## AI Models Used');
    for (const model of methodology.aiModelsUsed) {
      sections.push(`- **${model.name} (${model.provider}):** ${model.purpose}`);
    }
    sections.push('');
  }
  
  if (methodology.humanReviewers.length > 0) {
    sections.push('## Human Reviewers');
    for (const reviewer of methodology.humanReviewers) {
      sections.push(`- ${reviewer.role} (ID: ${reviewer.id}): Verified ${reviewer.verificationCount} finding(s)`);
    }
    sections.push('');
  }
  
  sections.push('## Finding Attribution Summary');
  sections.push(`- **Total Findings:** ${methodology.summary.totalFindings}`);
  sections.push(`- **Automated Checks:** ${methodology.summary.automatedFindings}`);
  sections.push(`- **AI-Suggested:** ${methodology.summary.aiSuggestedFindings}`);
  sections.push(`- **Human-Verified:** ${methodology.summary.humanVerifiedFindings}`);
  sections.push('');
  
  sections.push('## Attribution Key');
  sections.push('- **[AUTOMATED]:** Finding detected by automated testing tools');
  sections.push('- **[AI-SUGGESTED]:** Content suggested by AI model - requires human verification');
  sections.push('- **[HUMAN-VERIFIED]:** Finding confirmed by human accessibility specialist');
  sections.push('');
  
  sections.push('---');
  sections.push('');
  sections.push('## Legal Disclaimer');
  sections.push('');
  sections.push(methodology.disclaimer);
  
  return sections.join('\n');
}

export function generateFooterDisclaimer(): string {
  return `
---
${LEGAL_DISCLAIMER}

Report generated on ${new Date().toISOString().split('T')[0]} by ${TOOL_VERSION}
  `.trim();
}
