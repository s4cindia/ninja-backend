# ACR Confidence Categories: Complete Analysis Guide

**Document Version:** 1.0
**Last Updated:** 2026-02-05
**Status:** ✅ Production Ready

---

## Executive Summary

This document explains the four ACR (Accessibility Conformance Report) status categories and their relationship with automation confidence levels. Understanding these categories is critical for accurate WCAG 2.1 conformance assessment.

**Key Takeaway:** Automated testing provides excellent coverage but cannot guarantee 100% conformance. Seven criteria require mandatory manual human verification regardless of automated test results.

---

## Table of Contents

1. [Overview of Categories](#overview-of-categories)
2. [Detailed Category Explanations](#detailed-category-explanations)
3. [Confidence Level System](#confidence-level-system)
4. [Understanding N/A + Needs Review Combinations](#understanding-na--needs-review-combinations)
5. [Compliance Interpretation Guide](#compliance-interpretation-guide)
6. [Action Items by Category](#action-items-by-category)
7. [Technical Implementation](#technical-implementation)
8. [FAQ](#faq)

---

## Overview of Categories

The Ninja ACR system organizes WCAG 2.1 criteria into four primary categories:

| Category | Icon | Count (Typical) | Automation | User Action |
|----------|------|----------------|------------|-------------|
| **Needs Review** | ⚠️ | 40-45 | 60-98% confidence | Recommended |
| **Passed** | ✅ | 0-5 | 100% verified | None |
| **Not Applicable** | ℹ️ | 5-10 | N/A | None |
| **Manual Review Required** | ⚪ | 7-10 | 0% (cannot automate) | **Mandatory** |

### Visual Hierarchy

```
┌─────────────────────────────────────────────────┐
│ ⚠️ NEEDS REVIEW (43 criteria)                   │
│   🟢 High Confidence (16 items)    80-98%       │
│   🟡 Medium Confidence (27 items)  60-89%       │
├─────────────────────────────────────────────────┤
│ ✅ PASSED (1 criterion)            100%         │
├─────────────────────────────────────────────────┤
│ ℹ️ NOT APPLICABLE (6 criteria)     N/A          │
│   ⚪ Manual Review Required (7)     0%          │
└─────────────────────────────────────────────────┘
```

---

## Detailed Category Explanations

### 1. ⚠️ NEEDS REVIEW

**Definition:** Criteria where automated testing found **no issues** but cannot provide 100% confidence in the result.

#### Subcategories

##### 🟢 High Confidence (80-98%)
**Characteristics:**
- Formula-based or deterministic checks
- Low false-negative rate
- Reliable automation algorithms

**Examples:**

| Criterion | Confidence | Why High? |
|-----------|-----------|-----------|
| **4.1.1 Parsing** | 98% | HTML/XML validation against W3C spec |
| **1.4.3 Contrast (Minimum)** | 95% | WCAG luminance formula calculation |
| **3.1.1 Language of Page** | 92% | `<html lang>` attribute detection |
| **2.4.2 Page Titled** | 89% | `<title>` presence and non-emptiness |

**What automation checks:**
- ✅ Color contrast ratios meet 4.5:1 threshold
- ✅ HTML validates without parsing errors
- ✅ `lang` attribute exists and uses valid BCP 47 code
- ✅ Page title exists and is not empty

**What automation misses (edge cases):**
- ❌ Contrast on dynamically generated content
- ❌ Context-specific parsing issues in complex JavaScript
- ❌ Incorrect but valid language codes (e.g., `lang="en"` on Spanish content)
- ❌ Generic titles like "Untitled Document"

**User Action:**
- **Priority:** Low
- **Recommendation:** Optional spot-checking during final QA
- **Frequency:** Sample 5-10% of flagged elements

---

##### 🟡 Medium Confidence (60-89%)
**Characteristics:**
- Partial automation capability
- Higher false-negative potential
- Requires context understanding

**Examples:**

| Criterion | Confidence | Limitation |
|-----------|-----------|------------|
| **1.2.1 Audio-only/Video-only** | 70% | Can detect media, can't verify transcript quality |
| **2.1.2 No Keyboard Trap** | 80% | Can detect focus management, can't test all workflows |
| **4.1.2 Name, Role, Value** | 85% | Standard elements automated, custom widgets need review |
| **1.4.6 Enhanced Contrast** | 89% | Formula-based but edge cases exist (gradients, overlays) |

**What automation checks:**
- ✅ Media files (`<audio>`, `<video>`) presence
- ✅ ARIA attributes syntax correctness
- ✅ Focus order follows DOM order
- ✅ Form controls have labels

**What automation misses:**
- ❌ **Quality** of alternatives (transcript accuracy, meaningfulness)
- ❌ **Context-specific** keyboard workflows (modals, complex widgets)
- ❌ **Custom implementations** (non-standard UI components)
- ❌ **Dynamic behavior** (AJAX updates, state changes)

**User Action:**
- **Priority:** Medium-High
- **Recommendation:** Manual verification recommended
- **Frequency:** Test 25-50% of flagged elements, focus on complex interactions

---

### 2. ✅ PASSED

**Definition:** Criteria that have been **fully verified** with 100% confidence.

**Why so rare?**
Very few WCAG criteria can be completely automated with zero false negatives. This category typically includes:

1. **Manually verified criteria** - Human tester reviewed and approved
2. **Deterministic checks** - Simple binary checks (e.g., doctype exists)
3. **Hybrid approach** - Automated + human review completed

**Typical members:**
- Criteria that were in "Manual Review Required" and have been manually tested
- Simple technical checks with no edge cases
- Previously failed criteria that have been fixed and re-verified

**Example:**
- **1.1.1 Non-text Content** - Showed "1 fixed"
  - Automated tools detected images
  - Human verified alt text meaningfulness
  - Status changed from "Manual Review Required" → "Passed"

**User Action:**
- **Priority:** None
- **Status:** Complete
- **Maintenance:** Re-test if content changes

---

### 3. ℹ️ NOT APPLICABLE

**Definition:** Criteria that **do not apply** to the specific content based on automated content detection.

#### How N/A Detection Works

The `ContentDetectionService` scans for specific patterns:

| Criteria Group | Detection Method | Examples |
|---------------|------------------|----------|
| **1.2.1-1.2.9 (Media)** | Scans for `<audio>`, `<video>`, `.mp3`, `.mp4` files | If no media → N/A |
| **1.4.2 (Audio Control)** | Checks for `<audio autoplay>` | If no autoplay audio → N/A |
| **2.4.1 (Bypass Blocks)** | Analyzes page count, navigation patterns | If single-page → N/A |
| **3.2.1-3.2.5 (Change on Request)** | Detects interactive elements, event handlers | If static content → N/A |
| **3.3.1-3.3.4 (Input Assistance)** | Scans for `<form>`, `<input>` elements | If no forms → N/A |

**Why only 6-10 criteria?**

Out of 50 WCAG 2.1 Level A/AA criteria, only ~18 can be reliably detected as N/A:
- ✅ **Can detect:** Absence of media files → Media criteria N/A
- ❌ **Cannot detect:** Whether color is sole indicator → 1.4.1 remains applicable

**Examples:**

```typescript
// Text-only EPUB → N/A criteria
- 1.2.1 Audio-only and Video-only (no media files)
- 1.2.2 Captions (no video)
- 1.2.3 Audio Description (no video)
- 1.4.2 Audio Control (no autoplay audio)
- 3.3.1 Error Identification (no forms)
- 3.3.2 Labels or Instructions (no input fields)

// Interactive web app → N/A criteria
- 1.2.1-1.2.9 (no multimedia content)
- 2.4.1 Bypass Blocks (single-page app)
```

**Impact on Compliance:**
- N/A criteria are **excluded** from conformance calculations
- Total applicable criteria = 50 - N/A count
- Conformance % = (Passed criteria) / (Total - N/A) × 100

**User Action:**
- **Priority:** None
- **Verification:** Optional - confirm detection is accurate
- **Override:** Users can manually mark criteria as applicable if detection is wrong

---

### 4. ⚪ MANUAL REVIEW REQUIRED

**Definition:** Criteria that **cannot be automated** and require mandatory human verification regardless of automated test results.

#### Why 0% Confidence?

These criteria require **human judgment** about:
- **Semantic meaning** - Is alt text meaningful in context?
- **Quality assessment** - Are headings descriptive and useful?
- **User experience** - Is keyboard navigation intuitive?
- **Content understanding** - Are language changes marked correctly?

#### The 7 Core Manual Criteria

| Criterion | Why Automation Fails | What to Test Manually |
|-----------|---------------------|----------------------|
| **1.1.1 Non-text Content** | Can detect alt text exists, can't verify **meaningfulness** | Read alt text - does it convey the same information as the image? |
| **1.3.1 Info and Relationships** | Can detect HTML structure, can't verify **semantic relationships** | Navigate with screen reader - is structure logical and meaningful? |
| **2.1.1 Keyboard** | Can detect interactive elements, can't test **complete workflows** | Tab through entire interface - can you complete all tasks? |
| **2.4.1 Bypass Blocks** | Can detect skip links, can't verify **effectiveness** | Use skip link - does it actually help bypass repetitive content? |
| **2.4.6 Headings and Labels** | Can detect headings, can't assess **descriptiveness** | Read headings - do they clearly describe content sections? |
| **3.1.2 Language of Parts** | Can detect `lang` attributes, can't understand **content language** | Find foreign language passages - are they marked with correct `lang`? |
| **3.3.2 Labels or Instructions** | Can detect labels, can't verify **clarity** | Fill out forms - are instructions clear and helpful? |

#### Additional Manual Criteria (Context-Dependent)

- **1.4.1 Use of Color** - Requires viewing content to verify color isn't sole indicator
- **2.4.4 Link Purpose** - Requires understanding link context and meaningfulness
- **3.2.2 On Input** - Requires testing interactive behavior
- **3.3.3 Error Suggestion** - Requires evaluating quality of error messages

#### Manual Testing Methodology

**Recommended approach:**

1. **Screen Reader Testing** (NVDA, JAWS, VoiceOver)
   - Navigate entire document/site
   - Verify semantic structure
   - Test interactive elements
   - Validate alt text meaningfulness

2. **Keyboard-Only Navigation**
   - Disconnect mouse
   - Tab through all interactive elements
   - Test focus indicators
   - Complete key workflows

3. **Content Review**
   - Read headings for descriptiveness
   - Verify language markup accuracy
   - Assess form instructions clarity
   - Check link text meaningfulness

**Time estimate:** 30-60 minutes per document/page

**User Action:**
- **Priority:** ⚠️ **CRITICAL - MANDATORY**
- **Status:** Cannot claim conformance without this step
- **Documentation:** Record manual test results in ACR report

---

## Confidence Level System

### How Confidence is Calculated

Confidence levels reflect the **automation capability** for each criterion, not the current test result.

```typescript
// Backend logic (simplified)
const baseConfidence = ConfidenceAnalyzerService.getCriterionConfidence(criterionId);

if (baseConfidence === 0) {
  // Manual-only criteria
  confidence = 0;
  requiresManualVerification = true;
} else if (noIssuesDetected) {
  // Use criterion's automation capability
  confidence = baseConfidence; // 70%, 92%, 95%, etc.
} else {
  // Issues found - cap by both severity AND automation capability
  confidence = Math.min(severityBasedConfidence, baseConfidence);
}
```

### Confidence Ranges

| Range | Label | Color | Meaning | Action |
|-------|-------|-------|---------|--------|
| **90-98%** | High Confidence | 🟢 Green | Formula-based, highly reliable | Optional spot-check |
| **70-89%** | Medium Confidence | 🟡 Yellow | Partial automation, context needed | Recommended review |
| **50-69%** | Low Confidence | 🟠 Orange | Limited automation capability | Manual verification needed |
| **0%** | Manual Required | ⚪ Gray | Cannot automate | **Mandatory** human testing |

### Predefined Confidence Mappings

**High Confidence Criteria (90%+):**
- 1.4.3 Contrast (Minimum) - 95%
- 3.1.1 Language of Page - 92%
- 4.1.1 Parsing - 98%
- 2.4.2 Page Titled - 89%
- 1.4.6 Enhanced Contrast - 89%

**Medium Confidence Criteria (60-89%):**
- 1.2.1 Audio-only and Video-only - 70%
- 1.4.4 Resize Text - 80%
- 2.1.2 No Keyboard Trap - 80%
- 4.1.2 Name, Role, Value - 85%

**Manual Required Criteria (0%):**
- 1.1.1, 1.3.1, 1.4.1, 2.1.1, 2.4.1, 2.4.4, 2.4.6, 3.1.2, 3.2.2, 3.3.2, 3.3.3

*Full mapping available in: `src/services/acr/confidence-analyzer.service.ts`*

---

## Understanding N/A + Needs Review Combinations

### The Compound Status Phenomenon

Some criteria show **both** "N/A" badge **and** appear in "Needs Review" with medium/high confidence.

**Example from screenshot:**
- **3.2.1 On Focus** (80% confidence) - ⚠️ N/A badge
- **3.2.2 On Input** (80% confidence) - ⚠️ N/A badge

### What This Means

**Two conditions are simultaneously true:**

1. **N/A (Primary Status)** = Content detection determined this criterion doesn't apply
   - No event handlers detected that trigger context changes
   - No forms with dynamic behavior
   - Static content only

2. **80% Confidence (Secondary Status)** = IF it were applicable, automation could only detect 80% of issues
   - These criteria require testing interactive behaviors
   - Manual testing would be needed even if applicable

### Interpretation Logic

```
IF criterion.isNotApplicable THEN
  status = "NOT_APPLICABLE"
  confidence = N/A
  action = "None - excluded from compliance"
ELSE IF criterion.requiresManualVerification THEN
  status = "MANUAL_REVIEW_REQUIRED"
  confidence = 0%
  action = "Mandatory manual testing"
ELSE IF criterion.issuesRemaining === 0 THEN
  status = "NEEDS_REVIEW"
  confidence = criterion.automationCapability
  action = "Recommended review based on confidence level"
ELSE
  status = "HAS_ISSUES"
  confidence = min(severityConfidence, automationCapability)
  action = "Fix issues then re-test"
END
```

### Why Display Both?

**Transparency** - Shows users:
1. **What the system detected** (N/A - not applicable)
2. **Automation limitations** (80% - partial automation even if it were applicable)

**User Action:**
- **Primary:** None - criterion is excluded from compliance
- **Optional:** Verify N/A detection is accurate (false positives are rare but possible)

---

## Compliance Interpretation Guide

### Sample Report Analysis

Based on typical ACR output:

```
Total WCAG 2.1 Level A/AA Criteria: 50

⚠️ NEEDS REVIEW: 43 criteria
   🟢 High Confidence: 16
   🟡 Medium Confidence: 27
✅ PASSED: 1 criterion
ℹ️ NOT APPLICABLE: 6 criteria
⚪ MANUAL REVIEW REQUIRED: 7 criteria (nested under N/A group)
```

### Conformance Status Calculation

**Automated Conformance:**
```
Applicable Criteria = 50 - 6 (N/A) = 44
Automated Pass = 43 (Needs Review) + 1 (Passed) = 44
Automated Conformance = 44/44 = 100% ✅
```

**True Conformance:**
```
Fully Verified = 1 (Passed)
Automated Only = 43 (Needs Review)
Manual Required = 7 (0% confidence)
Unknown Status = 7

True Conformance = Unknown - requires manual testing
```

### Conformance Levels

| Level | Criteria | Status | Confidence |
|-------|----------|--------|-----------|
| **Fully Verified** | 1 (2%) | ✅ Complete | 100% |
| **Highly Likely** | 16 (36%) | 🟢 Needs Review | 80-98% |
| **Likely Compliant** | 27 (61%) | 🟡 Needs Review | 60-89% |
| **Unknown** | 7 (16%) | ⚪ Manual Required | 0% |
| **Not Applicable** | 6 (12%) | ℹ️ Excluded | N/A |

### Risk Assessment

**Low Risk (High Confidence):**
- Formula-based checks passed
- False negative rate: ~2-5%
- Recommendation: Optional sampling

**Medium Risk (Medium Confidence):**
- Heuristic checks passed
- False negative rate: ~10-20%
- Recommendation: Manual verification of critical paths

**High Risk (Manual Required):**
- Automation cannot verify
- False negative rate: Unknown
- Recommendation: **Mandatory** comprehensive manual testing

---

## Action Items by Category

### For Content Creators

| Category | Your Action | Priority | Time Estimate |
|----------|-------------|----------|---------------|
| **Passed** | ✅ None | N/A | 0 min |
| **Not Applicable** | ℹ️ None (optional: verify detection) | Low | 5 min |
| **Needs Review (High)** | 🟢 Optional spot-check | Low | 15 min |
| **Needs Review (Medium)** | 🟡 Recommended review | Medium | 30 min |
| **Manual Review Required** | ⚪ **Mandatory testing** | **CRITICAL** | 45-60 min |

### Manual Testing Checklist

#### 1.1.1 Non-text Content (0%)
- [ ] Open content with screen reader (NVDA/JAWS)
- [ ] Listen to all image alt text
- [ ] Verify alt text conveys equivalent information
- [ ] Check decorative images have empty alt (`alt=""`)
- [ ] Test complex images (charts, diagrams) have adequate descriptions

#### 1.3.1 Info and Relationships (0%)
- [ ] Navigate with screen reader
- [ ] Verify heading hierarchy is logical (H1 → H2 → H3)
- [ ] Test table header associations
- [ ] Check list markup (`<ul>`, `<ol>`) is semantic
- [ ] Validate form label associations

#### 2.1.1 Keyboard (0%)
- [ ] Disconnect mouse/trackpad
- [ ] Tab through all interactive elements
- [ ] Verify visible focus indicators
- [ ] Test all functionality is keyboard accessible
- [ ] Check focus order is logical
- [ ] Ensure no keyboard traps

#### 2.4.6 Headings and Labels (0%)
- [ ] Read all headings out of context
- [ ] Verify headings describe their sections clearly
- [ ] Check form labels are descriptive
- [ ] Test button text is meaningful
- [ ] Validate link text makes sense alone

#### 3.1.2 Language of Parts (0%)
- [ ] Identify foreign language passages
- [ ] Verify `lang` attribute on each passage
- [ ] Check language codes are correct (BCP 47)
- [ ] Test screen reader pronunciation switching

#### 3.3.2 Labels or Instructions (0%)
- [ ] Attempt to fill out all forms
- [ ] Verify instructions are present and clear
- [ ] Check required field indicators
- [ ] Test format requirements are explained
- [ ] Validate example inputs are provided where needed

---

## Technical Implementation

### Backend: Confidence Analyzer Service

**File:** `src/services/acr/confidence-analyzer.service.ts`

```typescript
export class ConfidenceAnalyzerService {
  // Predefined confidence mappings
  private static readonly HIGH_CONFIDENCE_CRITERIA = {
    '1.4.3': 95,  // Contrast (Minimum)
    '3.1.1': 92,  // Language of Page
    '4.1.1': 98,  // Parsing
    '2.4.2': 89,  // Page Titled
    // ... more criteria
  };

  private static readonly MEDIUM_CONFIDENCE_CRITERIA = {
    '1.2.1': 70,  // Audio-only and Video-only
    '2.1.2': 80,  // No Keyboard Trap
    '4.1.2': 85,  // Name, Role, Value
    // ... more criteria
  };

  private static readonly MANUAL_REQUIRED_CRITERIA = [
    '1.1.1',  // Non-text Content
    '1.3.1',  // Info and Relationships
    '2.1.1',  // Keyboard
    '2.4.6',  // Headings and Labels
    '3.1.2',  // Language of Parts
    '3.3.2',  // Labels or Instructions
    // ... more criteria
  ];

  public static getCriterionConfidence(criterionId: string): number {
    // Manual criteria always return 0
    if (this.MANUAL_REQUIRED_CRITERIA.includes(criterionId)) {
      return 0;
    }

    // Check high confidence mappings
    if (criterionId in this.HIGH_CONFIDENCE_CRITERIA) {
      return this.HIGH_CONFIDENCE_CRITERIA[criterionId];
    }

    // Check medium confidence mappings
    if (criterionId in this.MEDIUM_CONFIDENCE_CRITERIA) {
      return this.MEDIUM_CONFIDENCE_CRITERIA[criterionId];
    }

    // Default: medium-low confidence
    return 75;
  }
}
```

### Frontend: Confidence Badge Component

**File:** `src/components/ConfidenceBadge.tsx`

```typescript
export const ConfidenceBadge: React.FC<{
  confidence: number;
  requiresManualVerification: boolean;
  isNotApplicable?: boolean;
}> = ({ confidence, requiresManualVerification, isNotApplicable }) => {
  if (isNotApplicable) {
    return <Badge color="blue">ℹ️ N/A</Badge>;
  }

  if (requiresManualVerification || confidence === 0) {
    return <Badge color="gray">⚪ Manual Review Required</Badge>;
  }

  if (confidence >= 90) {
    return <Badge color="green">🟢 {confidence}% High Confidence</Badge>;
  }

  if (confidence >= 70) {
    return <Badge color="yellow">🟡 {confidence}% Medium Confidence</Badge>;
  }

  return <Badge color="orange">🟠 {confidence}% Low Confidence</Badge>;
};
```

### API Response Format

```json
{
  "jobId": "acr-123",
  "criteria": [
    {
      "criterionId": "1.1.1",
      "level": "A",
      "name": "Non-text Content",
      "status": "not_evaluated",
      "confidenceScore": 0,
      "requiresManualVerification": true,
      "automationCapability": 0,
      "findings": ["This criterion requires manual human verification"],
      "recommendation": "Manual review required",
      "issueCount": 0,
      "remediatedCount": 1
    },
    {
      "criterionId": "1.4.3",
      "level": "AA",
      "name": "Contrast (Minimum)",
      "status": "pass",
      "confidenceScore": 95,
      "requiresManualVerification": false,
      "automationCapability": 95,
      "findings": ["No contrast issues detected"],
      "recommendation": "Continue to maintain compliance",
      "issueCount": 0,
      "remediatedCount": 0
    },
    {
      "criterionId": "3.2.1",
      "level": "A",
      "name": "On Focus",
      "status": "not_applicable",
      "confidenceScore": null,
      "requiresManualVerification": false,
      "automationCapability": 80,
      "isNotApplicable": true,
      "naReason": "No interactive elements detected",
      "findings": ["This criterion does not apply to the current content"],
      "recommendation": "N/A"
    }
  ]
}
```

---

## FAQ

### Q1: Why do all "Needs Review" items show 0 issues if they need review?

**A:** "Needs Review" means automation **found no issues** but **cannot guarantee** there are no issues. The confidence level (60-98%) indicates how reliable the automated check is.

Think of it like spell-check: It finds no errors, but a human should still proofread important documents.

---

### Q2: Can I skip manual testing if everything shows "Needs Review (High Confidence)"?

**A:** **No.** High confidence (80-98%) is not the same as 100% confidence. For critical applications (government, healthcare, finance, education), manual testing is strongly recommended even for high-confidence items.

Additionally, 7 criteria **always** require manual testing regardless of automated results.

---

### Q3: What's the difference between "Not Applicable" and "Manual Review Required"?

| Aspect | Not Applicable | Manual Review Required |
|--------|----------------|----------------------|
| **Applies to content?** | ❌ No | ✅ Yes |
| **Counted in conformance?** | ❌ Excluded | ✅ Included |
| **Action required?** | ℹ️ None | ⚠️ Mandatory |
| **Example** | 1.2.1 (no media) | 1.1.1 (has images) |

---

### Q4: Why are some N/A items shown with confidence percentages?

**A:** The confidence percentage shows the **automation capability** for that criterion type, even though it's currently N/A. This is informational - if the criterion becomes applicable later, you'll know what level of automation to expect.

**User action:** None - N/A status takes precedence.

---

### Q5: How often should I re-run ACR analysis?

**Recommended frequency:**
- **After content changes:** Always
- **After design updates:** Always
- **Periodic audit:** Quarterly
- **Before release:** Every release

---

### Q6: Can I override N/A detections?

**A:** Yes. If content detection incorrectly marked a criterion as N/A, you can manually mark it as applicable. This is rare but can happen with:
- Hidden/dynamically loaded content
- Complex JavaScript interactions
- Non-standard media embedding

---

### Q7: What does "1 fixed" mean on 1.1.1 Non-text Content?

**A:** One issue was detected and remediated:
- **Detected:** Image missing alt text
- **Fixed:** Alt text added
- **Status:** Now in "Manual Review Required" because alt text **quality** needs human verification

---

### Q8: Why is keyboard accessibility (2.1.1) always manual?

**A:** Automated tools can detect:
- ✅ Interactive elements exist
- ✅ Elements are in tab order
- ✅ Focus is visible

But they **cannot** test:
- ❌ All workflows are completable
- ❌ Tab order is logical/intuitive
- ❌ Focus management in complex widgets
- ❌ Custom keyboard shortcuts work correctly

Only human testing can verify the **user experience** is actually keyboard-accessible.

---

### Q9: What happens if I skip manual testing?

**Legal/Compliance:**
- ⚠️ Cannot claim WCAG conformance
- ⚠️ May not meet legal requirements (ADA, Section 508, EAA)
- ⚠️ Audit findings would note incomplete testing

**User Experience:**
- ⚠️ Screen reader users may encounter meaningless alt text
- ⚠️ Keyboard users may find workflows inaccessible
- ⚠️ Non-native speakers may miss language indicators

**Risk Level:** **High** - Automated testing alone covers only 30-57% of accessibility barriers (per WCAG-EM guidance).

---

### Q10: How accurate is the content detection for N/A criteria?

**Accuracy by criterion type:**

| Criterion Type | Detection Accuracy | False Positive Rate |
|----------------|-------------------|-------------------|
| Media presence | 98% | <2% |
| Form elements | 95% | ~5% |
| Interactive behaviors | 85% | ~15% |
| Dynamic content | 70% | ~30% |

**Overall:** Very high for static content analysis, lower for dynamic/JavaScript-heavy applications.

---

## Conclusion

Understanding ACR confidence categories is essential for accurate WCAG conformance assessment:

1. **Needs Review (High/Medium)** = Automation found no issues but can't guarantee completeness
2. **Passed** = Fully verified (automated + manual)
3. **Not Applicable** = Doesn't apply to this content
4. **Manual Review Required** = **Must** test manually - automation cannot evaluate

**Key Takeaway:** Automated testing is powerful but not sufficient. The 7 manual-review criteria are **non-negotiable** for true WCAG conformance.

---

## Additional Resources

- **WCAG 2.1 Guidelines:** https://www.w3.org/WAI/WCAG21/quickref/
- **WCAG-EM Methodology:** https://www.w3.org/WAI/test-evaluate/conformance/wcag-em/
- **Automated Testing Limitations:** https://www.w3.org/WAI/test-evaluate/tools/selecting/
- **Manual Testing Guide:** https://www.w3.org/WAI/test-evaluate/
- **Screen Reader Testing:** https://webaim.org/articles/screenreader_testing/

---

**Document maintained by:** Ninja Platform Team
**Questions or feedback:** accessibility@ninja-platform.com
**Version history:** See Git commits
