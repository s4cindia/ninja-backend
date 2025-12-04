# Sprint 6 Replit Prompts
## Pathfinder Integration + Portfolio Compliance Dashboard

**Version:** 4.0 - ACR Research Update  
**Sprint Duration:** Weeks 11-12 (January 31 - February 14, 2026)  
**Total Story Points:** 69 (+18 from v3.0 - MEDIUM RISK)

---

## ⚡ ACR Research Update

> **New Stories in v4.0:**
> - **US-6.3.1:** ACR Version Tracking with Compliance Drift Warnings (+8 points)
> - **US-6.3.2:** Batch ACR Export for Entire Catalog (+5 points)
> - **US-6.3.3:** Compliance Deadline Tracking (+5 points)
> - **Total Addition:** +18 story points (MEDIUM RISK)

---

## Sprint 6 Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Auth** | JWT validation, Pathfinder SSO |
| **Visualization** | Chart.js or Recharts |
| **Export** | archiver (ZIP), exceljs (Excel) |
| **Email** | AWS SES |

---

## Epic 6.1: Pathfinder Integration

### Prompt US-6.1.1: Pathfinder JWT Integration

#### Context
Ninja Platform integrates with Pathfinder for single sign-on. Users authenticate via Pathfinder and receive a JWT that Ninja validates.

#### Technical Requirements

**Create file: `src/middleware/pathfinder-auth.middleware.ts`**

```typescript
import jwt from 'jsonwebtoken';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

interface PathfinderClaims {
  sub: string;          // user_id
  tenant_id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'user';
  exp: number;
  iat: number;
}

async function validatePathfinderToken(token: string): Promise<PathfinderClaims> {
  // Fetch Pathfinder public key from Secrets Manager
  const publicKey = await getPathfinderPublicKey();

  // Verify JWT signature and claims
  const claims = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: 'pathfinder.s4carlisle.com',
  }) as PathfinderClaims;

  return claims;
}

export function pathfinderAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const claims = await validatePathfinderToken(token);
    req.user = claims;
    req.tenantId = claims.tenant_id;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', redirect: '/pathfinder/login' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

#### Acceptance Criteria
- [ ] Given a user has logged into Pathfinder
- [ ] When they access Ninja platform
- [ ] Then the JWT token is validated against Pathfinder's public key
- [ ] And user claims (user_id, tenant_id, email, role) are extracted
- [ ] And session is established in Ninja
- [ ] And expired/invalid tokens redirect to Pathfinder login

---

### Prompt US-6.1.2: Pathfinder API Connection

*(Story Points: 5 - Fetches project context from Pathfinder API)*

---

### Prompt US-6.1.3: Unified Dashboard Navigation

*(Story Points: 5 - Cross-platform navigation with context preservation)*

---

## Epic 6.2: Portfolio Compliance Dashboard

### Prompt US-6.2.1: Product Catalog View

#### Context
Publishers need to see all their products with compliance status in a single view for portfolio management.

#### Technical Requirements

**Update database schema: `prisma/schema.prisma`**

```prisma
model Product {
  id              String    @id @default(uuid())
  tenantId        String
  title           String
  isbn            String?
  format          String    // 'pdf', 'epub'
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Compliance tracking
  lastAssessmentId  String?
  lastAssessmentAt  DateTime?
  complianceStatus  String    @default("not_assessed") // compliant, needs_attention, non_compliant, not_assessed
  complianceScore   Float?    // 0-100

  assessments     Assessment[]
  acrs            Acr[]

  @@index([tenantId])
  @@index([complianceStatus])
}
```

**Create file: `src/services/portfolio/catalog.service.ts`**

```typescript
interface ProductListOptions {
  tenantId: string;
  page: number;
  limit: number;
  filters?: {
    format?: 'pdf' | 'epub';
    status?: ComplianceStatus;
    assessedAfter?: Date;
    assessedBefore?: Date;
    acrEdition?: string;
  };
  search?: string;        // Title, ISBN, Product ID
  sortBy?: 'title' | 'lastAssessmentAt' | 'complianceScore';
  sortOrder?: 'asc' | 'desc';
}

interface ProductListResult {
  products: ProductWithStatus[];
  total: number;
  page: number;
  totalPages: number;
}

interface ProductWithStatus {
  id: string;
  title: string;
  isbn?: string;
  format: string;
  lastAssessmentAt?: Date;
  complianceStatus: ComplianceStatus;
  complianceScore?: number;
  acrStatus: 'current' | 'outdated' | 'missing';
  acrEditions: string[];
}

type ComplianceStatus = 'compliant' | 'needs_attention' | 'non_compliant' | 'not_assessed';
```

**Create API endpoint:**
```
GET /api/v1/portfolio/products
Query: page, limit, format, status, search, sortBy, sortOrder
Response: ProductListResult
```

#### Acceptance Criteria
- [ ] Given I am logged in as a tenant user
- [ ] When I navigate to the Portfolio Dashboard
- [ ] Then I see all products in my tenant's catalog
- [ ] And each product shows: Title, Format (PDF/EPUB), Last Assessment Date, Compliance Status
- [ ] And status indicators display: Compliant (green), Needs Attention (yellow), Non-Compliant (red), Not Assessed (gray)
- [ ] And I can filter by: Format, Status, Assessment Date, ACR Edition
- [ ] And I can search by: Title, ISBN, Product ID

---

### Prompt US-6.2.2: Compliance Heatmap

*(Story Points: 5 - Visual heatmap by WCAG criterion with trend charts)*

---

### Prompt US-6.2.3: Batch Validation Upload

*(Story Points: 8 - Multi-file upload with ZIP support and progress tracking)*

---

### Prompt US-6.2.4: ACR Status Tracking

*(Story Points: 5 - Current/Outdated/Missing status with expiry alerts)*

---

### Prompt US-6.2.5: Bulk ACR Export

*(Story Points: 5 - Download selected ACRs as ZIP)*

---

### Prompt US-6.2.6: Remediation Prioritization

*(Story Points: 5 - Issue ranking by severity and impact)*

---

## Epic 6.3: ACR Management [NEW]

### Prompt US-6.3.1: ACR Version Tracking with Compliance Drift Warnings [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Procurement officers look for evidence of continuous improvement. Version tracking with compliance drift warnings demonstrates commitment to accessibility.

#### Prerequisites
- US-3.3.8 (ACR Versioning and History) complete
- US-6.2.4 (ACR Status Tracking) complete

#### Objective
Track ACR versions with automatic compliance drift detection and improvement reporting.

#### Technical Requirements

**Create file: `src/services/acr/version-tracking.service.ts`**

```typescript
interface ComplianceDrift {
  productId: string;
  productTitle: string;
  previousVersion: number;
  currentVersion: number;
  previousScore: number;
  currentScore: number;
  scoreDelta: number;
  driftType: 'improved' | 'stable' | 'regressed';
  regressedCriteria: CriterionChange[];
  improvedCriteria: CriterionChange[];
}

interface CriterionChange {
  criterionId: string;
  wcagCriterion: string;
  previousLevel: ConformanceLevel;
  currentLevel: ConformanceLevel;
  remarks: string;
}

// Drift detection thresholds
const DRIFT_WARNING_THRESHOLD = -5;  // Warn if score drops >5%
const REGRESSION_ALERT_THRESHOLD = -10;  // Alert if score drops >10%

async function detectComplianceDrift(
  productId: string,
  currentAcrId: string
): Promise<ComplianceDrift | null> {
  // Get previous ACR version
  const previousAcr = await getPreviousAcrVersion(productId, currentAcrId);
  if (!previousAcr) return null;

  const currentAcr = await getAcrById(currentAcrId);

  // Calculate score delta
  const scoreDelta = currentAcr.complianceScore - previousAcr.complianceScore;

  // Determine drift type
  let driftType: 'improved' | 'stable' | 'regressed';
  if (scoreDelta >= 5) driftType = 'improved';
  else if (scoreDelta <= DRIFT_WARNING_THRESHOLD) driftType = 'regressed';
  else driftType = 'stable';

  // Identify regressed criteria
  const regressedCriteria = findRegressedCriteria(previousAcr, currentAcr);

  // Trigger warning if regression detected
  if (driftType === 'regressed') {
    await sendDriftWarningEmail(productId, scoreDelta, regressedCriteria);
  }

  return {
    productId,
    productTitle: currentAcr.product.title,
    previousVersion: previousAcr.version,
    currentVersion: currentAcr.version,
    previousScore: previousAcr.complianceScore,
    currentScore: currentAcr.complianceScore,
    scoreDelta,
    driftType,
    regressedCriteria,
    improvedCriteria: findImprovedCriteria(previousAcr, currentAcr),
  };
}
```

**Create improvement report generator:**

```typescript
interface ImprovementReport {
  productId: string;
  productTitle: string;
  reportPeriod: { start: Date; end: Date };
  versions: AcrVersionSummary[];
  overallTrend: 'improving' | 'stable' | 'declining';
  improvementHighlights: string[];
  areasOfFocus: string[];
}

async function generateImprovementReport(
  productId: string,
  startDate: Date,
  endDate: Date
): Promise<ImprovementReport> {
  // Get all ACR versions in date range
  // Calculate trend across versions
  // Generate narrative highlights for procurement responses
}
```

**Create API endpoints:**

```
GET /api/v1/products/:productId/acr-history
Response: { versions: AcrVersionSummary[], trend: TrendData }

GET /api/v1/products/:productId/compliance-drift
Response: ComplianceDrift[]

GET /api/v1/products/:productId/improvement-report?start=&end=
Response: ImprovementReport (also exportable as PDF)

POST /api/v1/alerts/drift-warning/configure
Body: { threshold: number, emailRecipients: string[] }
```

**Create React component: `src/components/portfolio/ComplianceTrend.tsx`**

Display:
- Line chart showing compliance score over time
- Version markers with clickable details
- Drift warnings highlighted in red
- Export button for Improvement Report

#### Acceptance Criteria
- [ ] Given multiple ACR versions exist for a product
- [ ] When I view ACR history
- [ ] Then compliance trend is visualized (improving/stable/declining)
- [ ] **[NEW]** And system warns when compliance score drops >5% between versions (drift warning)
- [ ] **[NEW]** And specific criteria that regressed are highlighted
- [ ] And version comparison shows improved/regressed/unchanged counts
- [ ] **[NEW]** And exportable 'Improvement Report' shows progress over time for procurement responses
- [ ] And email alerts are sent when drift warnings are triggered

---

### Prompt US-6.3.2: Batch ACR Export for Entire Catalog [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Publishers responding to RFPs need to provide ACRs for entire product lines. Batch export with summary index is essential for large catalog submissions.

#### Prerequisites
- US-6.2.5 (Bulk ACR Export) complete
- US-3.3.7 (ACR Document Export) complete

#### Objective
Enable batch export of ACRs for entire catalog with consistent naming and summary index.

#### Technical Requirements

**Create file: `src/services/acr/batch-export.service.ts`**

```typescript
import archiver from 'archiver';
import ExcelJS from 'exceljs';

interface BatchExportOptions {
  productIds: string[] | 'all';
  edition: AcrEdition;
  format: 'docx' | 'pdf' | 'html';
  includeIndex: boolean;
  tenantId: string;
}

interface BatchExportResult {
  jobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  totalProducts: number;
  processedProducts: number;
  downloadUrl?: string;
  expiresAt?: Date;
}

async function startBatchExport(options: BatchExportOptions): Promise<BatchExportResult> {
  // Create export job
  const job = await createExportJob(options);

  // For large catalogs (>50), queue as background job
  if (options.productIds === 'all' || options.productIds.length > 50) {
    await queueBatchExportJob(job.id, options);
    return { jobId: job.id, status: 'queued', totalProducts: 0, processedProducts: 0 };
  }

  // For smaller exports, process immediately
  return await processBatchExport(job.id, options);
}

async function processBatchExport(
  jobId: string,
  options: BatchExportOptions
): Promise<BatchExportResult> {
  const products = await getProducts(options.tenantId, options.productIds);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const indexData: IndexRow[] = [];

  for (const product of products) {
    const acr = await getLatestAcr(product.id, options.edition);
    if (!acr) continue;

    // Generate filename: {ProductName}_{Edition}_ACR_{Date}.{format}
    const filename = generateAcrFilename(product, options.edition, options.format);

    // Export ACR
    const acrBuffer = await exportAcr(acr.id, options.format);
    archive.append(acrBuffer, { name: filename });

    // Add to index
    indexData.push({
      productName: product.title,
      isbn: product.isbn,
      edition: options.edition,
      complianceScore: acr.complianceScore,
      lastUpdated: acr.generatedAt,
      filename,
    });

    await updateJobProgress(jobId, products.indexOf(product) + 1, products.length);
  }

  // Generate Excel summary index
  if (options.includeIndex) {
    const indexBuffer = await generateExcelIndex(indexData);
    archive.append(indexBuffer, { name: 'ACR_Summary_Index.xlsx' });
  }

  // Finalize archive
  await archive.finalize();

  // Upload to S3 with 7-day expiry
  const downloadUrl = await uploadToS3(archive, `exports/${jobId}.zip`, 7 * 24 * 60 * 60);

  // Send email notification
  await sendExportCompleteEmail(options.tenantId, downloadUrl);

  return {
    jobId,
    status: 'complete',
    totalProducts: products.length,
    processedProducts: products.length,
    downloadUrl,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

async function generateExcelIndex(data: IndexRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('ACR Summary');

  sheet.columns = [
    { header: 'Product Name', key: 'productName', width: 40 },
    { header: 'ISBN', key: 'isbn', width: 15 },
    { header: 'ACR Edition', key: 'edition', width: 15 },
    { header: 'Compliance %', key: 'complianceScore', width: 15 },
    { header: 'Last Updated', key: 'lastUpdated', width: 15 },
    { header: 'Filename', key: 'filename', width: 50 },
  ];

  sheet.addRows(data);

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E79' } };
  sheet.getRow(1).font = { color: { argb: 'FFFFFF' }, bold: true };

  return await workbook.xlsx.writeBuffer() as Buffer;
}
```

**Create API endpoints:**

```
POST /api/v1/acr/batch-export
Body: { productIds: string[] | 'all', edition: string, format: string }
Response: BatchExportResult

GET /api/v1/acr/batch-export/:jobId/status
Response: BatchExportResult

GET /api/v1/acr/batch-export/:jobId/download
Response: File download or redirect to S3 URL
```

#### Acceptance Criteria
- [ ] Given I have multiple products with current ACRs
- [ ] When I request batch export
- [ ] Then I can select multiple products (checkbox list) or 'Select All'
- [ ] And I can choose ACR edition (508, WCAG, EU, INT) for all products
- [ ] **[NEW]** And export generates ZIP containing individual ACR files with consistent naming
- [ ] **[NEW]** And ZIP includes Excel summary index: Product Name, ISBN, Edition, Compliance %, Last Updated, File Link
- [ ] And for large catalogs (>50 products), export runs as background job with email notification
- [ ] And download link is valid for 7 days

---

### Prompt US-6.3.3: Compliance Deadline Tracking [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Key regulatory deadlines: ADA Title II (April 2026 for 50K+ pop, April 2027 for smaller), EAA is NOW IN EFFECT (June 28, 2025 passed). Publishers need countdown tracking.

#### Prerequisites
- US-6.2.1 (Product Catalog View) complete
- US-6.2.4 (ACR Status Tracking) complete

#### Objective
Track regulatory and custom compliance deadlines with countdown alerts and risk indicators.

#### Technical Requirements

**Update database schema:**

```prisma
model ComplianceDeadline {
  id              String    @id @default(uuid())
  tenantId        String
  name            String
  description     String?
  deadlineDate    DateTime
  type            String    // 'regulatory' | 'contract' | 'audit' | 'custom'
  regulation      String?   // 'ADA_TITLE_II', 'EAA', 'SECTION_508', etc.
  isGlobal        Boolean   @default(false)  // System-wide vs tenant-specific

  // Alert configuration
  alertDays       Int[]     @default([90, 60, 30, 7])
  emailRecipients String[]

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([tenantId])
  @@index([deadlineDate])
}

model ProductDeadlineLink {
  id              String    @id @default(uuid())
  productId       String
  deadlineId      String
  riskStatus      String    // 'compliant', 'at_risk', 'critical'

  product         Product   @relation(fields: [productId], references: [id])
  deadline        ComplianceDeadline @relation(fields: [deadlineId], references: [id])

  @@unique([productId, deadlineId])
}
```

**Create file: `src/services/compliance/deadline-tracker.service.ts`**

```typescript
// Pre-configured regulatory deadlines
const REGULATORY_DEADLINES = [
  {
    name: 'ADA Title II - Large Entities',
    regulation: 'ADA_TITLE_II',
    deadlineDate: new Date('2026-04-24'),
    description: 'Web content accessibility deadline for state/local gov with 50,000+ population',
  },
  {
    name: 'ADA Title II - Small Entities',
    regulation: 'ADA_TITLE_II',
    deadlineDate: new Date('2027-04-26'),
    description: 'Web content accessibility deadline for state/local gov with <50,000 population',
  },
  {
    name: 'European Accessibility Act',
    regulation: 'EAA',
    deadlineDate: new Date('2025-06-28'),  // ALREADY PASSED
    description: 'EU market accessibility requirements - NOW IN EFFECT',
    isPast: true,
  },
];

interface DeadlineStatus {
  deadline: ComplianceDeadline;
  daysRemaining: number;
  isPast: boolean;
  riskLevel: 'green' | 'yellow' | 'red' | 'critical';
  productsAtRisk: number;
  productsCompliant: number;
}

function calculateRiskLevel(daysRemaining: number): string {
  if (daysRemaining < 0) return 'critical';  // Past due
  if (daysRemaining <= 30) return 'red';
  if (daysRemaining <= 90) return 'yellow';
  return 'green';
}

async function getDeadlineStatus(tenantId: string): Promise<DeadlineStatus[]> {
  const deadlines = await getDeadlines(tenantId);

  return Promise.all(deadlines.map(async (deadline) => {
    const daysRemaining = differenceInDays(deadline.deadlineDate, new Date());
    const products = await getProductsForDeadline(tenantId, deadline.id);

    return {
      deadline,
      daysRemaining,
      isPast: daysRemaining < 0,
      riskLevel: calculateRiskLevel(daysRemaining),
      productsAtRisk: products.filter(p => p.complianceStatus !== 'compliant').length,
      productsCompliant: products.filter(p => p.complianceStatus === 'compliant').length,
    };
  }));
}

// Scheduled job: Check deadlines daily and send alerts
async function checkDeadlineAlerts(): Promise<void> {
  const allDeadlines = await getAllActiveDeadlines();

  for (const deadline of allDeadlines) {
    const daysRemaining = differenceInDays(deadline.deadlineDate, new Date());

    if (deadline.alertDays.includes(daysRemaining)) {
      await sendDeadlineAlertEmail(deadline, daysRemaining);
    }
  }
}
```

**Create API endpoints:**

```
GET /api/v1/compliance/deadlines
Response: DeadlineStatus[]

POST /api/v1/compliance/deadlines
Body: { name, deadlineDate, type, description, alertDays, emailRecipients }
Response: ComplianceDeadline

GET /api/v1/compliance/deadlines/:id/products-at-risk
Response: { products: ProductWithStatus[], total: number }

POST /api/v1/compliance/deadlines/:id/link-products
Body: { productIds: string[] }

GET /api/v1/compliance/deadline-report
Response: { deadlines: DeadlineStatus[], summary: { critical: n, atRisk: n, onTrack: n } }
```

**Create React component: `src/components/compliance/DeadlineTracker.tsx`**

Display:
- Countdown cards for each deadline
- Color-coded risk indicators (green/yellow/red/critical)
- "X products at risk" badges
- EAA shows "NOW IN EFFECT" banner instead of countdown
- Add custom deadline button

#### Acceptance Criteria
- [ ] Given regulatory deadlines exist
- [ ] When I view the compliance dashboard
- [ ] **[NEW]** Then ADA Title II countdown shows: 'X days until April 24, 2026 deadline (50,000+ population entities)'
- [ ] **[NEW]** And EAA status shows: 'European Accessibility Act is NOW IN EFFECT - EU market access requires compliance'
- [ ] And I can set custom deadlines (e.g., contract renewal dates, audit dates)
- [ ] And products are flagged with deadline risk: Green (compliant), Yellow (<90 days), Red (<30 days)
- [ ] And email alerts are configurable at 90/60/30/7 days before deadline
- [ ] And deadline impact report shows: 'X products at risk for [deadline]'

---

## Sprint 6 Execution Checklist

### Week 11 (Jan 31 - Feb 7)
- [ ] US-6.1.1: Pathfinder JWT Integration
- [ ] US-6.1.2: Pathfinder API Connection
- [ ] US-6.1.3: Unified Dashboard Navigation
- [ ] US-6.2.1: Product Catalog View
- [ ] US-6.2.2: Compliance Heatmap
- [ ] US-6.2.3: Batch Validation Upload

### Week 12 (Feb 7-14)
- [ ] US-6.2.4: ACR Status Tracking
- [ ] US-6.2.5: Bulk ACR Export
- [ ] US-6.2.6: Remediation Prioritization
- [ ] US-6.3.1: ACR Version Tracking [NEW]
- [ ] US-6.3.2: Batch ACR Export (Catalog) [NEW]
- [ ] US-6.3.3: Compliance Deadline Tracking [NEW]

---

*End of Sprint 6 Replit Prompts v4.0*
