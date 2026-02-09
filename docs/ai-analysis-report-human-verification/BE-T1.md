# Backend Terminal 1 (BE-T1) - Services & AI Integration

**Branch:** `feature/ai-report-backend-1`
**Focus:** Core services, Gemini integration, AI logic
**Duration:** 10 weeks (3 phases)
**No Conflicts With:** BE-T2, FE-T1, FE-T2 (separate files)

---

## Your Responsibilities

You own all **service layer** files for AI Report generation and AI context enrichment:
- Report generator service
- AI context enricher service
- Progress tracker service
- Gemini service enhancements
- AI insights schema
- Business logic for prioritization

**DO NOT TOUCH:**
- Routes files (`src/routes/*.ts`)
- Controller files (`src/controllers/*.ts`)
- Frontend files

---

## Setup

```bash
# Navigate to project root
cd /c/Users/avrve/projects/ninja-workspace

# Create your worktree
git worktree add ninja-backend-be-t1 -b feature/ai-report-backend-1

# Navigate to your worktree
cd ninja-backend-be-t1

# Install dependencies
npm install

# Create your work branch
git checkout -b feature/ai-report-backend-1

# Start development server on custom port
npm run dev -- --port 3001
```

---

## Phase 1: Basic AI Report (Weeks 1-4)

### Week 1-2: Foundation

#### Task 1.1: Create ACR Report Generator Service

**File:** `src/services/acr/report-generator.service.ts`

```typescript
import { GeminiService } from '../ai/gemini.service';
import { ACRAnalysisService } from './acr-analysis.service';
import { z } from 'zod';

// Types
export interface ACRAnalysisReport {
  metadata: {
    jobId: string;
    contentTitle: string;
    analysisDate: Date;
    reportVersion: string;
  };
  executiveSummary: {
    overallConfidence: number;
    totalCriteria: number;
    automatedPassed: number;
    manualRequired: number;
    notApplicable: number;
    keyFindings: string[];
    criticalActions: CriticalAction[];
  };
  aiInsights: AIInsights | null;
  statistics: ACRStatistics;
  actionPlan: ActionPlan;
}

export interface CriticalAction {
  criterionId: string;
  name: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  estimatedTime: string;
}

export interface AIInsights {
  generatedAt: Date;
  model: string;
  topPriorities: Array<{
    criterionId: string;
    insight: string;
    recommendation: string;
    estimatedImpact: 'High' | 'Medium' | 'Low';
  }>;
  riskAssessment: {
    level: 'HIGH' | 'MEDIUM' | 'LOW';
    factors: string[];
  };
  specificRecommendations: string[];
}

export interface ACRStatistics {
  totalCriteria: number;
  automatedPassed: number;
  manualRequired: number;
  notApplicable: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  overallConfidence: number;
  levelACount: number;
  levelAACount: number;
}

export interface ActionPlan {
  phases: ActionPhase[];
  totalEstimatedTime: string;
}

export interface ActionPhase {
  name: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  estimatedTime: string;
  tasks: ActionTask[];
}

export interface ActionTask {
  criterionId: string;
  name: string;
  estimatedTime: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export class ACRReportGeneratorService {
  constructor(
    private readonly geminiService: GeminiService,
    private readonly acrAnalysisService: ACRAnalysisService
  ) {}

  async generateAnalysisReport(jobId: string): Promise<ACRAnalysisReport> {
    try {
      // 1. Fetch ACR results
      const acrResults = await this.acrAnalysisService.getAnalysisForJob(jobId);

      if (!acrResults) {
        throw new Error(`No ACR results found for job ${jobId}`);
      }

      // 2. Calculate statistics
      const stats = this.calculateStatistics(acrResults);

      // 3. Generate AI insights using Gemini
      const aiInsights = await this.generateAIInsights(acrResults, stats);

      // 4. Create action plan
      const actionPlan = this.generateActionPlan(acrResults);

      // 5. Assemble report
      return {
        metadata: {
          jobId,
          contentTitle: acrResults.contentTitle || 'Untitled',
          analysisDate: new Date(),
          reportVersion: '1.0-mvp'
        },
        executiveSummary: {
          overallConfidence: stats.overallConfidence,
          totalCriteria: stats.totalCriteria,
          automatedPassed: stats.automatedPassed,
          manualRequired: stats.manualRequired,
          notApplicable: stats.notApplicable,
          keyFindings: this.extractKeyFindings(stats, acrResults),
          criticalActions: this.extractCriticalActions(acrResults)
        },
        aiInsights,
        statistics: stats,
        actionPlan
      };
    } catch (error) {
      console.error('[ReportGenerator] Error generating report:', error);
      throw error;
    }
  }

  private calculateStatistics(acrResults: any): ACRStatistics {
    const criteria = acrResults.criteria || [];

    const manualRequired = criteria.filter((c: any) =>
      c.requiresManualVerification || c.confidence === 0
    ).length;

    const automatedPassed = criteria.filter((c: any) =>
      !c.requiresManualVerification &&
      c.confidence > 0 &&
      (c.status === 'pass' || c.issueCount === 0)
    ).length;

    const notApplicable = criteria.filter((c: any) =>
      c.status === 'not_applicable' || c.isNotApplicable
    ).length;

    const highConfidence = criteria.filter((c: any) =>
      c.confidence >= 80 && c.confidence < 100
    ).length;

    const mediumConfidence = criteria.filter((c: any) =>
      c.confidence >= 60 && c.confidence < 80
    ).length;

    const lowConfidence = criteria.filter((c: any) =>
      c.confidence > 0 && c.confidence < 60
    ).length;

    // Calculate overall confidence excluding N/A
    const applicableCriteria = criteria.filter((c: any) => !c.isNotApplicable);
    const overallConfidence = applicableCriteria.length > 0
      ? Math.round(
          applicableCriteria.reduce((sum: number, c: any) => sum + (c.confidence || 0), 0) /
          applicableCriteria.length
        )
      : 0;

    return {
      totalCriteria: criteria.length,
      automatedPassed,
      manualRequired,
      notApplicable,
      highConfidence,
      mediumConfidence,
      lowConfidence,
      overallConfidence,
      levelACount: criteria.filter((c: any) => c.level === 'A').length,
      levelAACount: criteria.filter((c: any) => c.level === 'AA').length
    };
  }

  private async generateAIInsights(
    acrResults: any,
    stats: ACRStatistics
  ): Promise<AIInsights | null> {
    try {
      // Prepare context for Gemini
      const manualCriteria = acrResults.criteria.filter((c: any) =>
        c.requiresManualVerification || c.confidence === 0
      );

      const prompt = `
You are an accessibility expert analyzing WCAG conformance report results.

Analysis Summary:
- Total Criteria: ${stats.totalCriteria}
- Automated Passed: ${stats.automatedPassed}
- Manual Required: ${stats.manualRequired}
- Overall Confidence: ${stats.overallConfidence}%

Manual Verification Required Criteria:
${manualCriteria.map((c: any) => `
- ${c.criterionId} ${c.name}
  Issues: ${c.issueCount || 0} remaining, ${c.remediatedCount || 0} fixed
  Related issues: ${JSON.stringify(c.relatedIssues?.slice(0, 3) || [])}
`).join('\n')}

Provide a JSON response with:
1. Top 3 priority items for manual review (with reasoning)
2. Risk assessment (HIGH/MEDIUM/LOW with factors)
3. Specific recommendations

Format as valid JSON matching this structure:
{
  "topPriorities": [
    {
      "criterionId": "1.1.1",
      "insight": "Brief analysis of detected patterns",
      "recommendation": "Specific action to take",
      "estimatedImpact": "High"
    }
  ],
  "riskAssessment": {
    "level": "MEDIUM",
    "factors": ["List of risk factors"]
  },
  "specificRecommendations": ["List of specific actions"]
}
`;

      const response = await this.geminiService.generateStructuredOutput(
        prompt,
        AIInsightsSchema
      );

      return {
        generatedAt: new Date(),
        model: 'gemini-2.0-flash-lite',
        ...response
      };
    } catch (error) {
      console.error('[ReportGenerator] Failed to generate AI insights:', error);
      // Return null if Gemini fails - report still works without AI insights
      return null;
    }
  }

  private extractKeyFindings(stats: ACRStatistics, acrResults: any): string[] {
    const findings: string[] = [];

    // Automated compliance finding
    if (stats.automatedPassed > 0) {
      findings.push(
        `Excellent automated compliance (${stats.automatedPassed}/${stats.totalCriteria - stats.notApplicable} criteria passed)`
      );
    }

    // Manual verification finding
    if (stats.manualRequired > 0) {
      findings.push(
        `${stats.manualRequired} criteria require mandatory manual verification`
      );
    }

    // Not applicable finding
    if (stats.notApplicable > 0) {
      findings.push(
        `${stats.notApplicable} criteria not applicable to this content type`
      );
    }

    // Confidence distribution finding
    if (stats.highConfidence > 0) {
      findings.push(
        `High confidence: ${stats.highConfidence} criteria (80-98% automation)`
      );
    }

    if (stats.mediumConfidence > 0) {
      findings.push(
        `Medium confidence: ${stats.mediumConfidence} criteria (60-89% automation)`
      );
    }

    return findings;
  }

  private extractCriticalActions(acrResults: any): CriticalAction[] {
    const manualCriteria = acrResults.criteria.filter((c: any) =>
      c.requiresManualVerification || c.confidence === 0
    );

    // Map to critical actions with time estimates
    return manualCriteria.slice(0, 7).map((c: any) => ({
      criterionId: c.criterionId || c.id,
      name: c.name,
      priority: this.determinePriority(c),
      estimatedTime: this.estimateTime(c)
    }));
  }

  private determinePriority(criterion: any): 'CRITICAL' | 'HIGH' | 'MEDIUM' {
    const criterionId = criterion.criterionId || criterion.id;
    const criticalCriteria = ['1.1.1', '1.3.1', '2.1.1'];
    const highCriteria = ['2.4.1', '2.4.6', '3.3.2'];

    if (criticalCriteria.includes(criterionId)) {
      return 'CRITICAL';
    } else if (highCriteria.includes(criterionId)) {
      return 'HIGH';
    } else {
      return 'MEDIUM';
    }
  }

  private estimateTime(criterion: any): string {
    const criterionId = criterion.criterionId || criterion.id;
    const timeMap: Record<string, string> = {
      '1.1.1': '15-20 min',
      '1.3.1': '10-15 min',
      '2.1.1': '15-20 min',
      '2.4.1': '8-10 min',
      '2.4.6': '8-10 min',
      '3.1.2': '5-8 min',
      '3.3.2': '8-10 min'
    };

    return timeMap[criterionId] || '10-15 min';
  }

  private generateActionPlan(acrResults: any): ActionPlan {
    const manualCriteria = acrResults.criteria.filter((c: any) =>
      c.requiresManualVerification || c.confidence === 0
    );

    const tasks: ActionTask[] = manualCriteria.map((c: any) => ({
      criterionId: c.criterionId || c.id,
      name: c.name,
      estimatedTime: this.estimateTime(c),
      status: 'pending' as const
    }));

    // Calculate total time
    const totalMinutes = tasks.reduce((sum, task) => {
      const minutes = parseInt(task.estimatedTime.split('-')[1] || '15');
      return sum + minutes;
    }, 0);

    const totalEstimatedTime = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m (approx)`;

    return {
      phases: [
        {
          name: 'Critical Manual Testing',
          priority: 'CRITICAL',
          estimatedTime: `${Math.floor(totalMinutes * 0.6)}min`,
          tasks: tasks.slice(0, 3)
        },
        {
          name: 'Additional Manual Testing',
          priority: 'HIGH',
          estimatedTime: `${Math.floor(totalMinutes * 0.4)}min`,
          tasks: tasks.slice(3)
        }
      ],
      totalEstimatedTime
    };
  }
}

// Zod schema for AI insights validation
const AIInsightsSchema = z.object({
  topPriorities: z.array(z.object({
    criterionId: z.string(),
    insight: z.string(),
    recommendation: z.string(),
    estimatedImpact: z.enum(['High', 'Medium', 'Low'])
  })).max(3),
  riskAssessment: z.object({
    level: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    factors: z.array(z.string())
  }),
  specificRecommendations: z.array(z.string())
});

export const reportGeneratorService = new ACRReportGeneratorService(
  geminiService,
  acrAnalysisService
);
```

**Testing:**
```bash
npm test src/services/acr/report-generator.service.test.ts
```

---

### Week 3-4: Gemini Integration Enhancement

#### Task 1.2: Enhance Gemini Service for Report Generation

**File:** `src/services/ai/gemini.service.ts` (enhance existing)

Add method for structured output with schema validation:

```typescript
// Add to existing GeminiService class

async generateStructuredOutput<T>(
  prompt: string,
  schema: z.ZodSchema<T>
): Promise<T> {
  try {
    const response = await this.generateText(prompt, {
      temperature: 0.2, // Low temperature for structured output
      maxTokens: 2048,
      systemPrompt: 'You are a helpful assistant that always responds with valid JSON.'
    });

    // Parse JSON response
    const parsed = JSON.parse(response);

    // Validate against schema
    const validated = schema.parse(parsed);

    return validated;
  } catch (error) {
    console.error('[Gemini] Structured output generation failed:', error);
    throw new Error('Failed to generate valid structured output');
  }
}

async generateReportInsights(
  criteria: any[],
  stats: any
): Promise<any> {
  const manualCriteria = criteria.filter(c =>
    c.requiresManualVerification || c.confidence === 0
  );

  const prompt = `
Analyze this WCAG conformance report and provide insights.

Statistics:
- Total: ${stats.totalCriteria}
- Automated Passed: ${stats.automatedPassed}
- Manual Required: ${stats.manualRequired}
- Overall Confidence: ${stats.overallConfidence}%

Manual Criteria:
${manualCriteria.map(c => `
- ${c.criterionId}: ${c.name}
  Issues: ${c.issueCount || 0} remaining
  Confidence: ${c.confidence}%
`).join('\n')}

Respond with JSON containing:
1. topPriorities: Top 3 items needing manual review
2. riskAssessment: Overall risk level and factors
3. specificRecommendations: Actionable recommendations

Be specific and reference actual criterion IDs and issues.
`;

  return this.generateStructuredOutput(prompt, AIInsightsSchema);
}
```

**Testing:**
```bash
npm test src/services/ai/gemini.service.test.ts
```

---

## Phase 2: Basic Integration (Weeks 5-8)

### Week 5-6: AI Context Enricher

#### Task 2.1: Create AI Context Enricher Service

**File:** `src/services/acr/ai-context-enricher.service.ts`

```typescript
import { GeminiService } from '../ai/gemini.service';
import { ConfidenceAnalyzerService } from './confidence-analyzer.service';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

export interface AIContext {
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  priorityReason: string;
  estimatedTime: string;
  riskScore: number; // 0-100
  detectedIssues: string[];
  recommendations: string[];
}

export interface EnrichedQueueItem {
  id: string;
  criterionId: string;
  wcagCriterion: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidenceLevel: string;
  status: string;
  aiContext: AIContext;
  relatedIssues?: any[];
  fixedIssues?: any[];
  verificationHistory: any[];
}

export class AIContextEnricherService {
  constructor(
    private readonly geminiService: GeminiService,
    private readonly confidenceAnalyzer: ConfidenceAnalyzerService
  ) {}

  async enrichVerificationQueue(
    jobId: string,
    criteriaIds: string[],
    aiInsights: any,
    acrResults: any
  ): Promise<EnrichedQueueItem[]> {
    const items: EnrichedQueueItem[] = [];

    for (const criterionId of criteriaIds) {
      // Get base confidence analysis
      const confidence = this.confidenceAnalyzer.analyzeConfidence(criterionId);

      // Get ACR criterion data
      const criterionData = acrResults.criteria.find(
        (c: any) => c.id === criterionId || c.criterionId === criterionId
      );

      // Generate AI context
      const aiContext = await this.generateAIContext(
        criterionId,
        criterionData,
        aiInsights
      );

      items.push({
        id: uuidv4(),
        criterionId,
        wcagCriterion: confidence.wcagCriterion,
        severity: this.getSeverity(criterionId),
        confidenceLevel: confidence.confidenceLevel,
        status: 'PENDING',
        aiContext,
        relatedIssues: criterionData?.relatedIssues || [],
        fixedIssues: criterionData?.fixedIssues || [],
        verificationHistory: []
      });
    }

    // Sort by priority
    items.sort((a, b) => {
      const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      return priorityOrder[a.aiContext.priority] - priorityOrder[b.aiContext.priority];
    });

    return items;
  }

  private async generateAIContext(
    criterionId: string,
    criterionData: any,
    aiInsights: any
  ): Promise<AIContext> {
    // Check if AI insights already has info for this criterion
    const priorityInfo = aiInsights?.topPriorities?.find(
      (p: any) => p.criterionId === criterionId
    );

    // Determine priority
    const priority = this.determinePriority(criterionId, criterionData);

    // Generate priority reason
    const priorityReason = priorityInfo?.insight ||
      this.generatePriorityReason(criterionId, criterionData);

    // Estimate time
    const estimatedTime = this.estimateTime(criterionId);

    // Calculate risk score
    const riskScore = this.calculateRiskScore(criterionId, criterionData);

    // Extract detected issues
    const detectedIssues = this.extractDetectedIssues(criterionData);

    // Generate recommendations
    const recommendations = priorityInfo?.recommendation
      ? [priorityInfo.recommendation]
      : this.generateRecommendations(criterionId);

    return {
      priority,
      priorityReason,
      estimatedTime,
      riskScore,
      detectedIssues,
      recommendations
    };
  }

  private determinePriority(
    criterionId: string,
    criterionData: any
  ): 'CRITICAL' | 'HIGH' | 'MEDIUM' {
    const criticalCriteria = ['1.1.1', '1.3.1', '2.1.1'];
    const highCriteria = ['2.4.1', '2.4.6'];

    if (criticalCriteria.includes(criterionId)) {
      return 'CRITICAL';
    }

    // Elevate priority if many issues
    if (criterionData && criterionData.issueCount > 10) {
      return 'HIGH';
    }

    if (highCriteria.includes(criterionId)) {
      return 'HIGH';
    }

    return 'MEDIUM';
  }

  private generatePriorityReason(
    criterionId: string,
    criterionData: any
  ): string {
    const issueCount = criterionData?.issueCount || 0;
    const fixedCount = criterionData?.remediatedCount || 0;

    if (issueCount > 10) {
      return `High volume (${issueCount} issues detected) requiring thorough review`;
    }

    if (fixedCount > 0) {
      return `${fixedCount} issues remediated - verification needed to confirm fixes`;
    }

    const reasonMap: Record<string, string> = {
      '1.1.1': 'Alt text quality cannot be automated - requires human judgment of meaningfulness',
      '1.3.1': 'Semantic structure requires understanding of content relationships',
      '2.1.1': 'Complete keyboard workflows must be tested by humans',
      '2.4.1': 'Bypass block effectiveness requires manual testing',
      '2.4.6': 'Heading descriptiveness requires content understanding',
      '3.1.2': 'Language identification requires content comprehension',
      '3.3.2': 'Form instruction clarity requires human assessment'
    };

    return reasonMap[criterionId] || 'Manual verification required for complete assessment';
  }

  private estimateTime(criterionId: string): string {
    const timeMap: Record<string, string> = {
      '1.1.1': '15-20 minutes',
      '1.3.1': '10-15 minutes',
      '2.1.1': '15-20 minutes',
      '2.4.1': '8-10 minutes',
      '2.4.6': '8-10 minutes',
      '3.1.2': '5-8 minutes',
      '3.3.2': '8-10 minutes'
    };

    return timeMap[criterionId] || '10-15 minutes';
  }

  private calculateRiskScore(
    criterionId: string,
    criterionData: any
  ): number {
    let score = 50; // Base score

    // Critical criteria start higher
    const criticalCriteria = ['1.1.1', '1.3.1', '2.1.1'];
    if (criticalCriteria.includes(criterionId)) {
      score += 20;
    }

    // Add score for issue volume
    const issueCount = criterionData?.issueCount || 0;
    if (issueCount > 20) score += 20;
    else if (issueCount > 10) score += 15;
    else if (issueCount > 5) score += 10;
    else if (issueCount > 0) score += 5;

    // Reduce score if issues were fixed
    const fixedCount = criterionData?.remediatedCount || 0;
    if (fixedCount > 0) score -= 10;

    return Math.min(Math.max(score, 0), 100);
  }

  private extractDetectedIssues(criterionData: any): string[] {
    if (!criterionData || !criterionData.relatedIssues) {
      return ['No automated issues detected - manual verification still required'];
    }

    // Summarize issues
    const issues = criterionData.relatedIssues.slice(0, 3).map((issue: any) =>
      issue.message || 'Issue detected'
    );

    const total = criterionData.relatedIssues.length;
    if (total > 3) {
      issues.push(`... and ${total - 3} more issues`);
    }

    return issues;
  }

  private generateRecommendations(criterionId: string): string[] {
    const recommendationMap: Record<string, string[]> = {
      '1.1.1': [
        'Use screen reader (NVDA/JAWS) to verify alt text meaningfulness',
        'Check that decorative images have empty alt attributes',
        'Verify complex images have adequate long descriptions'
      ],
      '1.3.1': [
        'Navigate with screen reader to verify heading hierarchy',
        'Test table header associations',
        'Verify semantic markup (lists, headings, landmarks)'
      ],
      '2.1.1': [
        'Test all interactive elements with keyboard only',
        'Verify complete workflows are keyboard accessible',
        'Check focus indicators are visible'
      ],
      '2.4.1': [
        'Test skip link functionality',
        'Verify bypass blocks are effective',
        'Check with screen reader'
      ],
      '2.4.6': [
        'Read all headings out of context',
        'Verify descriptiveness and clarity',
        'Check form labels are meaningful'
      ],
      '3.1.2': [
        'Identify foreign language passages',
        'Verify lang attribute on each passage',
        'Test screen reader pronunciation'
      ],
      '3.3.2': [
        'Attempt to fill out all forms',
        'Verify instructions are clear',
        'Check required field indicators'
      ]
    };

    return recommendationMap[criterionId] || [
      'Review WCAG criterion documentation',
      'Perform manual testing',
      'Document findings'
    ];
  }

  private getSeverity(criterionId: string): 'critical' | 'serious' | 'moderate' | 'minor' {
    const severityMap: Record<string, 'critical' | 'serious' | 'moderate' | 'minor'> = {
      '1.1.1': 'critical',
      '1.3.1': 'critical',
      '2.1.1': 'critical',
      '2.4.1': 'serious',
      '2.4.6': 'moderate',
      '3.1.2': 'minor',
      '3.3.2': 'moderate'
    };

    return severityMap[criterionId] || 'moderate';
  }
}

export const aiContextEnricher = new AIContextEnricherService(
  geminiService,
  confidenceAnalyzerService
);
```

**Testing:**
```bash
npm test src/services/acr/ai-context-enricher.service.test.ts
```

---

## Phase 3: Progress Tracking (Weeks 9-10)

#### Task 3.1: Create Progress Tracker Service

**File:** `src/services/acr/progress-tracker.service.ts`

```typescript
import { EventEmitter } from 'events';
import { HumanVerificationService } from './human-verification.service';

export interface VerificationProgress {
  total: number;
  completed: number;
  pending: number;
  percentComplete: number;
  criticalComplete: boolean;
  estimatedRemainingTime: string;
  lastUpdated: Date;
}

export interface VerificationCompletedEvent {
  jobId: string;
  itemId: string;
  criterionId: string;
  status: string;
  progress: VerificationProgress;
}

export class ProgressTrackerService {
  private eventEmitter = new EventEmitter();

  constructor(
    private readonly humanVerificationService: HumanVerificationService
  ) {}

  async trackCompletion(
    jobId: string,
    itemId: string,
    verification: any
  ): Promise<VerificationProgress> {
    // Get current queue state
    const queue = await this.humanVerificationService.getQueue(jobId);

    // Calculate progress
    const progress = this.calculateProgress(queue);

    // Emit event for real-time updates
    this.eventEmitter.emit('verification.completed', {
      jobId,
      itemId,
      criterionId: verification.criterionId,
      status: verification.status,
      progress
    });

    // Check if all critical items complete
    if (progress.criticalComplete) {
      this.eventEmitter.emit('verification.criticalComplete', {
        jobId,
        progress
      });
    }

    return progress;
  }

  async getCurrentProgress(jobId: string): Promise<VerificationProgress> {
    const queue = await this.humanVerificationService.getQueue(jobId);
    return this.calculateProgress(queue);
  }

  private calculateProgress(queue: any): VerificationProgress {
    const critical = queue.items.filter((i: any) => i.severity === 'critical');
    const criticalComplete = critical.every((i: any) =>
      i.status === 'VERIFIED_PASS' ||
      i.status === 'VERIFIED_FAIL' ||
      i.status === 'VERIFIED_PARTIAL'
    );

    const estimatedRemainingTime = this.calculateRemainingTime(queue);

    return {
      total: queue.totalItems,
      completed: queue.verifiedItems,
      pending: queue.pendingItems,
      percentComplete: Math.round((queue.verifiedItems / queue.totalItems) * 100),
      criticalComplete,
      estimatedRemainingTime,
      lastUpdated: new Date()
    };
  }

  private calculateRemainingTime(queue: any): string {
    const pendingItems = queue.items.filter((i: any) => i.status === 'PENDING');

    // Estimate based on criterion IDs
    const timeMap: Record<string, number> = {
      '1.1.1': 20,
      '1.3.1': 15,
      '2.1.1': 20,
      '2.4.1': 10,
      '2.4.6': 10,
      '3.1.2': 8,
      '3.3.2': 10
    };

    const totalMinutes = pendingItems.reduce((sum: number, item: any) => {
      return sum + (timeMap[item.criterionId] || 10);
    }, 0);

    if (totalMinutes < 60) {
      return `${totalMinutes} min`;
    } else {
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${hours}h ${minutes}m`;
    }
  }

  onVerificationCompleted(
    callback: (event: VerificationCompletedEvent) => void
  ): void {
    this.eventEmitter.on('verification.completed', callback);
  }

  onCriticalComplete(
    callback: (event: { jobId: string; progress: VerificationProgress }) => void
  ): void {
    this.eventEmitter.on('verification.criticalComplete', callback);
  }
}

export const progressTracker = new ProgressTrackerService(
  humanVerificationService
);
```

**Testing:**
```bash
npm test src/services/acr/progress-tracker.service.test.ts
```

---

## Commit Strategy

### After Each Task:
```bash
# Add your files
git add src/services/acr/report-generator.service.ts
git add src/services/acr/ai-context-enricher.service.ts
git add src/services/acr/progress-tracker.service.ts

# Commit with descriptive message
git commit -m "feat(be-t1): Add report generator service

- Implement ACRReportGeneratorService
- Add Gemini integration for AI insights
- Calculate statistics and action plans
- Add comprehensive error handling

Phase: 1
Task: 1.1"

# Push to your branch
git push origin feature/ai-report-backend-1
```

### Weekly Sync:
```bash
# Pull latest from main
git fetch origin
git rebase origin/main

# Resolve conflicts if any
# Push updated branch
git push origin feature/ai-report-backend-1 --force-with-lease
```

---

## Testing Requirements

### Unit Tests (Per File):
```typescript
// src/services/acr/report-generator.service.test.ts

describe('ACRReportGeneratorService', () => {
  describe('generateAnalysisReport', () => {
    it('should generate complete report', async () => {
      // Test implementation
    });

    it('should handle missing ACR results', async () => {
      // Test error handling
    });

    it('should work without AI insights if Gemini fails', async () => {
      // Test graceful degradation
    });
  });

  describe('calculateStatistics', () => {
    it('should calculate correct statistics', () => {
      // Test statistics calculation
    });
  });
});
```

**Run Tests:**
```bash
npm test -- --watch
```

---

## Definition of Done

### Task Completion Checklist:
- [ ] Code written and tested locally
- [ ] Unit tests passing (80%+ coverage)
- [ ] No TypeScript errors
- [ ] ESLint passing
- [ ] Code commented where complex
- [ ] Error handling implemented
- [ ] Committed with descriptive message
- [ ] Pushed to feature branch

### Phase Completion Checklist:
- [ ] All tasks in phase complete
- [ ] Integration tests passing
- [ ] No conflicts with main branch
- [ ] Ready for code review
- [ ] Documentation updated
- [ ] Demo prepared for team

---

## Communication

### Daily Updates:
Post in team channel:
```
BE-T1 Update (Day X):
✅ Completed: Report generator service core logic
🚧 In Progress: Gemini AI insights integration
⏸️ Blocked: None
📅 Tomorrow: Complete AI insights testing
```

### Questions/Blockers:
- Tag team lead in Slack
- Include file name and line number
- Provide context and what you've tried

---

## Resources

- **Gemini API Docs:** https://ai.google.dev/docs
- **Zod Schema Validation:** https://zod.dev
- **TypeScript Handbook:** https://www.typescriptlang.org/docs/

---

**Status:** Ready to start
**Estimated Completion:** 10 weeks
**Next:** Review plan, set up worktree, start Phase 1 Task 1.1
