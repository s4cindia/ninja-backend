# Sprint 7 Replit Prompts
## UI/UX Polish + Comprehensive Testing

**Version:** 4.0 - ACR Research Update  
**Sprint Duration:** Weeks 13-14 (February 14 - February 28, 2026)  
**Total Story Points:** 63 (+8 from v3.0 - LOW RISK)

---

## 🎯 FEATURE FREEZE

All new features must be complete by the end of this sprint. Sprint 8 is reserved for demo preparation only.

---

## ⚡ ACR Research Update

> **New Stories in v4.0:**
> - **US-7.5.1:** ACR Quality Validation (+5 points) - Warn if >95% 'Supports' ratings
> - **US-7.5.2:** Legal Disclaimer Templates (+3 points) - Counsel-reviewed disclaimers

---

## Epic 7.1: Security Audit & Performance

### Prompt US-7.1.1: Security Audit

*(Story Points: 8 - OWASP Top 10, dependency scanning, auth review)*

### Prompt US-7.1.2: Performance Optimization

*(Story Points: 5 - API <200ms p95, page load <3s)*

### Prompt US-7.1.3: Database Optimization

*(Story Points: 5 - Query optimization, indexing, connection pooling)*

---

## Epic 7.2: UI/UX Polish

### Prompt US-7.2.1: Responsive Design Verification

*(Story Points: 5 - Desktop/laptop/tablet/mobile breakpoints)*

### Prompt US-7.2.2: Accessibility Testing (WCAG 2.1 AA)

*(Story Points: 8 - Ninja platform itself must be accessible)*

### Prompt US-7.2.3: Error State Handling

*(Story Points: 3 - Clear, actionable error messages)*

### Prompt US-7.2.4: Loading States & Progress Indicators

*(Story Points: 3 - Progress bars, skeleton loaders)*

---

## Epic 7.3: Comprehensive Testing

### Prompt US-7.3.1: End-to-End Test Suite

*(Story Points: 8 - Playwright tests for critical paths)*

### Prompt US-7.3.2: Integration Test Coverage

*(Story Points: 5 - Jest + Supertest for API testing)*

### Prompt US-7.3.3: User Acceptance Testing

*(Story Points: 5 - Internal user validation)*

---

## Epic 7.4: Documentation

### Prompt US-7.4.1: API Documentation

*(Story Points: 3 - OpenAPI/Swagger spec)*

### Prompt US-7.4.2: User Guide

*(Story Points: 3 - In-app help system)*

---

## Epic 7.5: ACR Quality Assurance [NEW]

### Prompt US-7.5.1: ACR Quality Validation [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Sophisticated procurement teams view reports claiming 100% 'Supports' ratings as indicators of fraud or incompetence. System should warn users before they submit suspicious ACRs.

#### Prerequisites
- US-3.3.4 (Nuanced Compliance Status) complete
- ACR generation working

#### Objective
Implement quality validation that warns users when ACRs appear suspiciously perfect.

#### Technical Requirements

**Create file: `src/services/acr/quality-validator.service.ts`**

```typescript
interface QualityWarning {
  type: 'HIGH_COMPLIANCE' | 'LOW_REMARKS' | 'UNVERIFIED_SUPPORTS';
  severity: 'warning' | 'critical';
  message: string;
  recommendation: string;
  affectedCriteria?: string[];
}

interface QualityValidationResult {
  isValid: boolean;
  warnings: QualityWarning[];
  statistics: {
    totalCriteria: number;
    supportsCount: number;
    supportsPercentage: number;
    withRemarksCount: number;
    humanVerifiedCount: number;
  };
  canProceed: boolean;
  requiresAcknowledgment: boolean;
}

// Quality thresholds based on research
const QUALITY_THRESHOLDS = {
  MAX_SUPPORTS_PERCENTAGE: 95,      // Warn if >95% Supports
  MIN_REMARKS_PERCENTAGE: 5,        // Warn if <5% have remarks
  REQUIRE_HUMAN_VERIFICATION: true, // Warn if Supports lacks verification
};

async function validateAcrQuality(acrId: string): Promise<QualityValidationResult> {
  const acr = await getAcrById(acrId);
  const warnings: QualityWarning[] = [];

  // Calculate statistics
  const totalCriteria = acr.criteria.length;
  const supportsCount = acr.criteria.filter(c => c.level === 'Supports').length;
  const supportsPercentage = (supportsCount / totalCriteria) * 100;
  const withRemarksCount = acr.criteria.filter(c => c.remarks && c.remarks.length > 20).length;
  const humanVerifiedCount = acr.criteria.filter(c => c.humanVerified).length;

  // Check for suspiciously high compliance
  if (supportsPercentage > QUALITY_THRESHOLDS.MAX_SUPPORTS_PERCENTAGE) {
    warnings.push({
      type: 'HIGH_COMPLIANCE',
      severity: 'warning',
      message: `ACR shows ${supportsPercentage.toFixed(1)}% "Supports" ratings. ` +
               `Procurement reviewers may view claims above 95% skeptically.`,
      recommendation: 'Review each criterion carefully. Consider adding detailed remarks ' +
                      'even for "Supports" items to demonstrate thorough assessment.',
    });
  }

  // Check for missing remarks
  const remarksPercentage = (withRemarksCount / totalCriteria) * 100;
  if (remarksPercentage < QUALITY_THRESHOLDS.MIN_REMARKS_PERCENTAGE) {
    warnings.push({
      type: 'LOW_REMARKS',
      severity: 'warning',
      message: `Only ${remarksPercentage.toFixed(1)}% of criteria have detailed remarks. ` +
               `Credible ACRs typically include specific implementation details.`,
      recommendation: 'Add quantitative details to remarks (e.g., "387 of 412 images have alt text").',
    });
  }

  // Check for unverified "Supports" claims
  const unverifiedSupports = acr.criteria.filter(
    c => c.level === 'Supports' && !c.humanVerified
  );
  if (unverifiedSupports.length > 0) {
    warnings.push({
      type: 'UNVERIFIED_SUPPORTS',
      severity: 'critical',
      message: `${unverifiedSupports.length} criteria are marked "Supports" without human verification.`,
      recommendation: 'Complete human verification before finalizing ACR to ensure accuracy.',
      affectedCriteria: unverifiedSupports.map(c => c.criterionId),
    });
  }

  return {
    isValid: warnings.length === 0,
    warnings,
    statistics: {
      totalCriteria,
      supportsCount,
      supportsPercentage,
      withRemarksCount,
      humanVerifiedCount,
    },
    canProceed: true, // User can proceed after acknowledging
    requiresAcknowledgment: warnings.length > 0,
  };
}
```

**Create API endpoints:**

```
GET /api/v1/acr/:acrId/quality-check
Response: QualityValidationResult

POST /api/v1/acr/:acrId/acknowledge-warnings
Body: { warningTypes: string[], acknowledgedBy: string }
Response: { acknowledged: true, timestamp: Date }
```

**Create React component: `src/components/acr/QualityWarningModal.tsx`**

Display modal when finalizing ACR with warnings:
- List all warnings with severity icons
- Explain implications for procurement
- "Review ACR" button returns to editor
- "I understand, proceed anyway" button with checkbox acknowledgment
- Log acknowledgment to audit trail

#### Acceptance Criteria
- [ ] Given an ACR is being finalized
- [ ] When the system validates ACR quality
- [ ] **[NEW]** Then WARNING if >95% of criteria are marked 'Supports'
- [ ] **[NEW]** And WARNING if <5% have detailed remarks
- [ ] **[NEW]** And WARNING if items marked 'Supports' lack human verification
- [ ] And warning message explains: 'Procurement reviewers may view high compliance claims skeptically'
- [ ] And user can acknowledge warning and proceed, or return to edit
- [ ] And acknowledgment is logged in audit trail

---

### Prompt US-7.5.2: Legal Disclaimer Templates [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** False Claims Act risk: Knowingly false ACRs to government face treble damages. FTC fined accessibility overlay provider $1M for AI claims. Legal disclaimers reduce liability.

#### Prerequisites
- US-3.3.5 (AI Disclaimer and Attribution) complete
- US-3.3.7 (ACR Document Export) complete

#### Objective
Implement configurable legal disclaimer templates for all ACR exports.

#### Technical Requirements

**Create file: `src/services/acr/disclaimer.service.ts`**

```typescript
interface DisclaimerTemplate {
  id: string;
  tenantId: string | null;  // null = system default
  name: string;
  type: 'footer' | 'methodology' | 'ai_attribution';
  content: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// System default disclaimers (counsel-reviewed)
const SYSTEM_DISCLAIMERS = {
  footer: {
    name: 'Standard Legal Disclaimer',
    content: `This Accessibility Conformance Report (ACR) was generated using the Ninja Platform, 
which employs automated testing tools supplemented by AI-assisted analysis. Automated accessibility 
scanners typically detect 30-57% of potential accessibility barriers. Items requiring subjective 
assessment or user testing may require additional human verification.

This report represents the accessibility status at the time of assessment. Accessibility may vary 
with software updates or content changes. For the most current accessibility information, please 
contact the product vendor.

VPAT® is a registered service mark of the Information Technology Industry Council (ITI).`,
  },

  methodology: {
    name: 'Assessment Methodology',
    content: `ASSESSMENT METHODOLOGY

This ACR was generated using the following approach:

1. AUTOMATED TESTING: The Ninja Platform performed automated accessibility checks against 
   WCAG 2.1 Level AA criteria using industry-standard validation tools.

2. AI-ASSISTED ANALYSIS: Google Gemini AI was used to:
   - Suggest alternative text for images (marked as [AI-SUGGESTED])
   - Generate remediation recommendations
   - Identify potential accessibility issues

3. HUMAN VERIFICATION: Items marked [HUMAN-VERIFIED] were manually tested by accessibility 
   professionals using assistive technologies including NVDA, JAWS, and VoiceOver.

4. LIMITATIONS: Automated tools cannot assess all accessibility criteria. Criteria requiring 
   subjective judgment (e.g., "meaningful" alternative text, logical reading order) were 
   flagged for human review.

AI-assisted content requires human verification for accuracy.`,
  },

  ai_attribution: {
    name: 'AI Attribution Notice',
    content: `AI ATTRIBUTION NOTICE

This report contains AI-generated content, indicated by the [AI-SUGGESTED] tag. AI-suggested 
content is provided as a starting point and requires human review and verification before use.

The AI model used (Google Gemini) may produce inaccurate or incomplete suggestions. The vendor 
is responsible for verifying all accessibility claims before submission to procurement authorities.

Anthropic and Google disclaim any liability for decisions made based on AI-suggested content.`,
  },
};

async function getDisclaimers(tenantId: string): Promise<{
  footer: DisclaimerTemplate;
  methodology: DisclaimerTemplate;
  aiAttribution: DisclaimerTemplate;
}> {
  // Get tenant-specific disclaimers, falling back to system defaults
  const tenantDisclaimers = await getTenantDisclaimers(tenantId);

  return {
    footer: tenantDisclaimers.footer || SYSTEM_DISCLAIMERS.footer,
    methodology: tenantDisclaimers.methodology || SYSTEM_DISCLAIMERS.methodology,
    aiAttribution: tenantDisclaimers.aiAttribution || SYSTEM_DISCLAIMERS.ai_attribution,
  };
}
```

**Update ACR export to include disclaimers:**

```typescript
// In acr-exporter.service.ts
async function exportAcr(acrId: string, format: ExportFormat): Promise<Buffer> {
  const acr = await getAcrById(acrId);
  const disclaimers = await getDisclaimers(acr.tenantId);

  // Add methodology section after product info
  // Add footer disclaimer on every page
  // Add AI attribution if any AI-suggested content exists
  // Add ITI trademark notice
}
```

**Create database schema:**

```prisma
model DisclaimerTemplate {
  id        String    @id @default(uuid())
  tenantId  String?   // null = system default
  name      String
  type      String    // 'footer', 'methodology', 'ai_attribution'
  content   String    @db.Text
  isDefault Boolean   @default(false)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([tenantId])
  @@unique([tenantId, type, isDefault])
}
```

**Create API endpoints:**

```
GET /api/v1/disclaimers
Response: { footer, methodology, aiAttribution }

PUT /api/v1/disclaimers/:type
Body: { content: string }
Response: DisclaimerTemplate

POST /api/v1/disclaimers/:type/reset
Response: { reset: true } // Reset to system default
```

#### Acceptance Criteria
- [ ] Given an ACR is exported
- [ ] When the document is generated
- [ ] **[NEW]** Then standard legal disclaimer is included in footer of all pages
- [ ] **[NEW]** And Assessment Methodology section explains automated vs human verification
- [ ] **[NEW]** And AI attribution clearly states: 'AI-suggested content requires human verification'
- [ ] And disclaimer templates are configurable per tenant (for custom legal language)
- [ ] And ITI VPAT trademark notice is included

---

## Sprint 7 Execution Checklist

### Week 13 (Feb 14-21)
- [ ] US-7.1.1: Security Audit
- [ ] US-7.1.2: Performance Optimization
- [ ] US-7.1.3: Database Optimization
- [ ] US-7.2.1: Responsive Design Verification
- [ ] US-7.2.2: Accessibility Testing (WCAG 2.1 AA)
- [ ] US-7.2.3: Error State Handling
- [ ] US-7.2.4: Loading States & Progress Indicators

### Week 14 (Feb 21-28)
- [ ] US-7.3.1: End-to-End Test Suite
- [ ] US-7.3.2: Integration Test Coverage
- [ ] US-7.3.3: User Acceptance Testing
- [ ] US-7.4.1: API Documentation
- [ ] US-7.4.2: User Guide
- [ ] US-7.5.1: ACR Quality Validation [NEW]
- [ ] US-7.5.2: Legal Disclaimer Templates [NEW]

---

*End of Sprint 7 Replit Prompts v4.0*
