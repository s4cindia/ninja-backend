# Sprint 8 Replit Prompts
## Demo Preparation & Rehearsal

**Version:** 4.0 - ACR Research Update  
**Sprint Duration:** Week 15 (February 28 - March 7, 2026)  
**Total Story Points:** 30 (no change - demo prep only)

---

## 🎯 LONDON BOOK FAIR: MARCH 10-12, 2026

---

## ⚡ ACR Research Update

> **Demo Script Revisions in v4.0:**
> - **Risk Mitigation Narrative:** Lead with contract protection, not cost savings
> - **Correct Terminology:** Use "ACR" not "VPAT" for completed reports
> - **Credibility Focus:** Emphasize human verification and confidence levels
> - **Regulatory Context:** Reference ADA Title II (April 2026) and EAA (now in effect)

---

## Demo Scenario

| Element | Details |
|---------|---------|
| **Persona** | David Chen, Accessibility Director at Summit Educational Publishing |
| **Situation** | California State University requires current ACRs for all 47 textbooks by April 2026 for contract renewal worth $3.2M annually |
| **Key Message** | "Protect your institutional contracts with procurement-ready Accessibility Conformance Reports" |

---

## Epic 8.1: Demo Environment Setup

### Prompt US-8.1.1: Demo Environment Deployment

Deploy stable, isolated demo environment with:
- Separate AWS infrastructure
- Pre-loaded sample data
- Quick reset scripts
- Backup failover environment

### Prompt US-8.1.2: Sample Publisher Catalog

Create realistic 47-title catalog with:
- Mix of PDF and EPUB formats
- Varied accessibility status (31 compliant, 12 needs attention, 4 issues)
- Realistic issues (alt text, contrast, tables)
- ACRs at various states (current, outdated, missing)

### Prompt US-8.1.3: Demo Account Configuration

Configure "David Chen" account with:
- Accessibility Director role
- Pre-configured dashboard showing compelling starting state
- Quick reset capability

---

## Epic 8.2: Demo Script & Rehearsal

### Prompt US-8.2.1: Risk Mitigation Demo Script [REVISED]

#### Context
> 🔬 **RESEARCH DRIVER:** Shift from productivity messaging to risk mitigation. Publishers buy compliance tools to protect contracts, not save time. Lead with contract protection narrative.

#### Opening Hook

> "Meet David. He's about to lose a $3.2 million contract—not because his textbooks aren't good, but because he can't prove they're accessible. His customer, the California State University system, just added ADA Title II compliance to their contract renewal requirements. David has 47 textbooks in their catalog. He needs 47 Accessibility Conformance Reports. By June. Today, we're going to show him how."

#### Demo Flow (15 minutes)

| Step | Duration | Script |
|------|----------|--------|
| **1. Portfolio Upload** | 2 min | "Let's upload David's entire catalog to Ninja Platform. Drag and drop... all 47 titles uploading now." |
| **2. Batch Validation** | 2 min | "One click to run accessibility validation across the entire catalog. The system is checking WCAG 2.1 criteria, PDF/UA compliance, and Section 508 requirements." |
| **3. Compliance Heatmap** | 2 min | "Here's where David stands: 31 titles already pass—that's 66%. 12 need minor remediation. 4 have significant issues. Let's drill into one of the problem titles." |
| **4. Deep Dive** | 3 min | "Grade 10 Biology has 23 images missing alt text and 3 tables without proper headers. Notice the confidence levels: HIGH for contrast checks, MEDIUM for alt text presence, MANUAL VERIFICATION REQUIRED for alt text quality. The AI suggests alt text, but a human needs to verify it's meaningful." |
| **5. ACR Generation** | 3 min | "For our compliant titles, let's generate ACRs. We recommend the INT edition—it satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document. Perfect for David's multinational customers." |
| **6. Portfolio Export** | 2 min | "Download all 31 ACRs in one ZIP with a summary index. David can include this in his contract renewal response tomorrow." |

#### Closing Message

> "In 15 minutes, David knows exactly where he stands. He has 31 ACRs ready to include in his contract renewal response. He has a prioritized remediation plan for the rest. And most importantly, he's not going to lose $3.2 million because he couldn't answer a compliance question."

#### Key Talking Points

1. **Contract Protection, Not Cost Savings**
   - "What's at risk? $3.2 million. What's the cost of Ninja? A fraction of that."

2. **Honest About AI Limitations**
   - "We're transparent: AI detects 30-57% of issues. That's why we show confidence levels."

3. **Credibility Through Nuance**
   - "Notice we don't claim 100% compliance. Sophisticated procurement teams view that as a red flag."

4. **Regulatory Urgency**
   - "ADA Title II deadline is April 2026 for entities over 50,000 population. The EAA is already in effect in Europe."

### Prompt US-8.2.2: Demo Rehearsals

Schedule and conduct:
- Feb 28: First full run-through
- Mar 3: Refinement rehearsal
- Mar 5: Final dress rehearsal
- Record all rehearsals for review
- Train backup presenter

### Prompt US-8.2.3: Objection Handling Guide [REVISED]

#### Top Objections & Responses

| Objection | Response |
|-----------|----------|
| "We can't afford this right now" | "What's the cost of losing your CSU contract? The Ninja subscription is a fraction of contract revenue. Think of it as contract insurance." |
| "We already have accessibility processes" | "Great—this enhances them. Ninja handles the documentation burden so your team can focus on actual remediation." |
| "How accurate are AI assessments?" | "We're transparent: AI detects 30-57% of issues. That's why we show confidence levels and require human verification for 'Supports' ratings. We never claim what we can't prove." |
| "What about legal liability?" | "Every ACR includes methodology disclosure and legal disclaimers. We actually warn you if your ACR looks too perfect—that's a red flag for procurement teams." |
| "Can't we just do this manually?" | "Absolutely. For 47 titles at 2-3 hours each, that's 100+ hours of work. Ninja gets you 80% there in minutes, so your team can focus on the 20% that needs human judgment." |
| "What if regulations change?" | "Ninja tracks regulatory deadlines—ADA Title II, EAA, Section 508 refreshes. You'll know before your competitors when requirements change." |

---

## Epic 8.3: Contingency & Backup Plans

### Prompt US-8.3.1: Offline Demo Capability

Prepare for internet failures:
- Pre-recorded video of full demo
- PDF walkthrough with screenshots
- Local Docker environment on presenter laptop

### Prompt US-8.3.2: Technical Backup Procedures

Document and test:
- Environment reset procedure
- Data restore procedure
- Escalation contacts
- Backup presenter readiness

---

## Epic 8.4: Marketing Collateral

### Prompt US-8.4.1: Leave-Behind Materials [REVISED]

Create professional collateral with research-driven messaging:

**One-Pager Content:**
- Headline: "Protect Your Institutional Contracts"
- Key stats: ADA Title II deadline, EAA enforcement, Section 508 Best Meets
- Value prop: "Generate procurement-ready ACRs for your entire catalog"
- Pricing: Contact for quote (don't show pricing at demo)
- CTA: Schedule follow-up demo

**ROI Calculator:**
- Input: Number of titles, average contract value, current compliance process hours
- Output: Time savings, risk reduction, cost comparison

### Prompt US-8.4.2: Demo Video Recording

Record professional demo video:
- High-quality screen capture with audio
- Captioned for accessibility (practice what we preach)
- Hosted on website for post-event sharing
- 5-minute and 15-minute versions

---

## Sprint 8 Execution Checklist

### Week 15 (Feb 28 - Mar 7)

#### Days 1-2 (Feb 28 - Mar 1)
- [ ] Deploy demo environment (US-8.1.1)
- [ ] Load sample catalog (US-8.1.2)
- [ ] Configure demo accounts (US-8.1.3)
- [ ] First rehearsal

#### Days 3-4 (Mar 3-4)
- [ ] Finalize demo script (US-8.2.1)
- [ ] Create objection guide (US-8.2.3)
- [ ] Refinement rehearsal
- [ ] Test backup procedures (US-8.3.2)

#### Days 5-6 (Mar 5-6)
- [ ] Final rehearsals (US-8.2.2)
- [ ] Prepare offline backup (US-8.3.1)
- [ ] Print leave-behinds (US-8.4.1)
- [ ] Record demo video (US-8.4.2)

#### Day 7 (Mar 7)
- [ ] Final environment check
- [ ] Travel to London
- [ ] Team arrives March 9

---

## 🎯 LONDON BOOK FAIR: MARCH 10-12, 2026 🎯

---

*End of Sprint 8 Replit Prompts v4.0*
