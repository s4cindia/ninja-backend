# CI/CD Pipeline Implementation Prompts

## Overview

This document contains Replit/Claude prompts for implementing a comprehensive CI/CD pipeline for the Ninja Platform's Job Detail View testing.

| Step | Description | Target | Files |
|------|-------------|--------|-------|
| 1 | GitHub Actions Workflow | Repository Root | `.github/workflows/ci.yml` |
| 2 | Playwright Configuration | Frontend | `playwright.config.ts` |
| 3 | E2E Test Examples | Frontend | `e2e/job-detail.e2e.ts` |
| 4 | Accessibility Tests | Frontend | `e2e/job-detail.a11y.ts` |
| 5 | Responsive Tests | Frontend | `e2e/job-detail.responsive.ts` |
| 6a | Frontend Test Scripts | Frontend | `package.json`, `vitest.config.ts` |
| 6b | Backend Test Scripts | Backend | `package.json`, `vitest.*.config.ts` |
| 7 | Coverage Gates | Repository Root | `codecov.yml` |
| 8 | PR Template | Repository Root | `.github/PULL_REQUEST_TEMPLATE.md` |

---

## Step 1: GitHub Actions Workflow

**Target:** Repository Root
**File:** `.github/workflows/ci.yml`

```
## Task: Create GitHub Actions CI/CD Pipeline

Create a comprehensive CI/CD pipeline for the Ninja Platform that runs on every push and PR.

### Location
Create file: `.github/workflows/ci.yml`

### Pipeline Stages

**Stage 1: Lint & Type Check (Fast Feedback)**
- Run ESLint on both frontend and backend
- Run TypeScript type checking
- Should fail fast if code quality issues exist

**Stage 2: Unit Tests (Parallel)**
- Run frontend unit tests (Vitest) with coverage
- Run backend unit tests (Vitest) with coverage
- Upload coverage reports to Codecov
- Minimum coverage: 80%

**Stage 3: Integration & API Tests**
- Requires PostgreSQL service container
- Requires Redis service container
- Run Prisma migrations on test database
- Seed test data
- Run integration tests with coverage

**Stage 4: E2E Tests (Parallel)**
- Start backend server
- Run Playwright tests across 3 browsers (Chrome, Firefox, Safari)
- Upload Playwright HTML report as artifact
- Retry failed tests twice in CI

**Stage 5: Accessibility Tests**
- Run axe-core accessibility scans via Playwright
- Validate WCAG 2.1 AA compliance
- Upload accessibility report as artifact

**Stage 6: Visual Regression (PR only)**
- Only run on pull requests
- Compare screenshots against baseline
- Upload visual diffs on failure

**Final Gate**
- All previous stages must pass
- Block merge if any stage fails

### Environment Variables Required
```yaml
env:
  DATABASE_URL: postgresql://test:test@localhost:5432/ninja_test
  REDIS_URL: redis://localhost:6379
  JWT_SECRET: test-secret-key
  NODE_VERSION: '20'
```

### Service Containers
```yaml
services:
  postgres:
    image: postgres:15
    env:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: ninja_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
  redis:
    image: redis:7
    ports:
      - 6379:6379
    options: >-
      --health-cmd "redis-cli ping"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

### Triggers
- Push to: main, develop
- Pull request to: main, develop

### Artifacts to Upload
1. `playwright-report/` - E2E test report (30 days retention)
2. `accessibility-report/` - A11y report
3. `visual-diff/` - Visual regression diffs (on failure only)
4. `coverage/` - Code coverage reports

### Key Actions to Use
- `actions/checkout@v4`
- `actions/setup-node@v4` with npm cache
- `actions/upload-artifact@v4`
- `codecov/codecov-action@v4`

### Job Dependencies
```
lint → unit-tests-frontend (parallel) → integration-tests → e2e-tests (parallel) → ci-success
     → unit-tests-backend  (parallel) →                  → accessibility-tests →
```

### Notes
- Use `npm ci` (not `npm install`) for faster, deterministic installs
- Use `npx wait-on` to wait for backend server before E2E tests
- Set `fullyParallel: true` in Playwright for faster execution
- Use job dependencies (`needs:`) to create proper stage ordering
```

---

## Step 2: Playwright Configuration

**Target:** Frontend (`ninja-frontend/`)
**File:** `playwright.config.ts`

```
## Task: Configure Playwright for E2E, Accessibility, Responsive, and Visual Testing

Set up Playwright test runner with multiple test projects for different testing scenarios.

### Location
Create file: `ninja-frontend/playwright.config.ts`

### Requirements

#### 1. Base Configuration
```typescript
{
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,  // Fail if .only in CI
  retries: process.env.CI ? 2 : 0,  // Retry twice in CI
  workers: process.env.CI ? 1 : undefined,  // Single worker in CI for stability
  timeout: 30000,  // 30 second timeout per test
}
```

#### 2. Reporters
- HTML reporter: `playwright-report/` folder
- JUnit reporter: `test-results/junit.xml` for CI integration
- Console reporter for local development

#### 3. Global Settings (`use`)
```typescript
{
  baseURL: process.env.VITE_API_URL || 'http://localhost:5000',
  trace: 'on-first-retry',  // Capture trace on retry
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
}
```

#### 4. Test Projects

**E2E Tests - Cross Browser:**
| Project Name | Device | Test Pattern |
|--------------|--------|--------------|
| chromium | Desktop Chrome | `*.e2e.ts` |
| firefox | Desktop Firefox | `*.e2e.ts` |
| webkit | Desktop Safari | `*.e2e.ts` |

**Responsive Tests:**
| Project Name | Device | Test Pattern |
|--------------|--------|--------------|
| mobile-chrome | Pixel 5 | `*.responsive.ts` |
| mobile-safari | iPhone 12 | `*.responsive.ts` |
| tablet | iPad Pro | `*.responsive.ts` |

**Accessibility Tests:**
| Project Name | Device | Test Pattern |
|--------------|--------|--------------|
| accessibility | Desktop Chrome | `*.a11y.ts` |

**Visual Regression Tests:**
| Project Name | Device | Test Pattern |
|--------------|--------|--------------|
| visual | Desktop Chrome | `*.visual.ts` |

#### 5. Web Server (Optional for Local)
```typescript
webServer: {
  command: 'npm run dev',
  url: 'http://localhost:5000',
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
}
```

### Dependencies to Install
```bash
npm install -D @playwright/test @axe-core/playwright
npx playwright install
```

### Folder Structure to Create
```
ninja-frontend/
├── e2e/
│   ├── fixtures/           # Test fixtures and helpers
│   │   └── test-base.ts    # Extended test with auth
│   ├── job-detail.e2e.ts   # E2E tests
│   ├── job-detail.a11y.ts  # Accessibility tests
│   ├── job-detail.responsive.ts  # Responsive tests
│   └── job-detail.visual.ts      # Visual regression tests
├── playwright.config.ts
└── playwright-report/      # Generated reports (gitignore)
```

### Example Project Definition
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    baseURL: process.env.VITE_API_URL || 'http://localhost:5000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*\.e2e\.ts/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /.*\.e2e\.ts/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: /.*\.e2e\.ts/,
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testMatch: /.*\.responsive\.ts/,
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 12'] },
      testMatch: /.*\.responsive\.ts/,
    },
    {
      name: 'tablet',
      use: { ...devices['iPad Pro'] },
      testMatch: /.*\.responsive\.ts/,
    },
    {
      name: 'accessibility',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*\.a11y\.ts/,
    },
    {
      name: 'visual',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*\.visual\.ts/,
    },
  ],
});
```
```

---

## Step 3: E2E Test Examples

**Target:** Frontend (`ninja-frontend/`)
**File:** `e2e/job-detail.e2e.ts`

```
## Task: Create E2E Tests for Job Detail View

Write Playwright E2E tests covering the main user flows for the Job Detail page.

### Location
Create file: `ninja-frontend/e2e/job-detail.e2e.ts`

### Test Setup

#### Authentication Fixture
Create a reusable auth fixture that logs in before tests:
```typescript
// e2e/fixtures/test-base.ts
import { test as base } from '@playwright/test';

export const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
    await use(page);
  },
});

export { expect } from '@playwright/test';
```

### Test Cases to Implement

| Test ID | Test Case | Steps | Assertions |
|---------|-----------|-------|------------|
| MT-E2E-001 | Full user flow | Login → Jobs → View → Remediate | Each page loads correctly |
| MT-E2E-002 | Start Remediation | Click button on job detail | URL = `/remediation/:id` |
| MT-E2E-003 | Download Report | Click Download button | File download triggered |
| MT-E2E-004 | Re-Audit | Click Re-Audit button | New job created, toast shown |
| MT-E2E-005 | Back navigation | Click Back button | URL = `/jobs` |
| MT-E2E-006 | Raw data toggle | Click Show/Hide | JSON visibility toggles |
| MT-E2E-007 | Filter issues | Select severity filter | Table rows filtered |
| MT-E2E-008 | Sort issues | Click column header | Table sorted, indicator shown |
| MT-E2E-009 | Refresh page | Press F5 on job detail | Data persists correctly |
| MT-E2E-010 | Deep link | Navigate directly to job URL | Page loads with data |

### Test Implementation

```typescript
import { test, expect } from '@playwright/test';

test.describe('Job Detail View - E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('MT-E2E-001: complete user flow - Jobs to View to Remediate', async ({ page }) => {
    // Navigate to jobs list
    await page.goto('/jobs');
    await expect(page.locator('h1')).toContainText('Jobs');

    // Click first View button
    await page.click('[data-testid="view-job-btn"] >> nth=0');

    // Verify job detail page loaded
    await expect(page).toHaveURL(/\/jobs\/[\w-]+/);
    await expect(page.locator('[data-testid="compliance-score"]')).toBeVisible();
    await expect(page.locator('[data-testid="severity-summary"]')).toBeVisible();
    await expect(page.locator('[data-testid="issues-table"]')).toBeVisible();

    // Click Start Remediation
    await page.click('[data-testid="start-remediation-btn"]');
    await expect(page).toHaveURL(/\/remediation\/[\w-]+/);
  });

  test('MT-E2E-002: Start Remediation navigates correctly', async ({ page }) => {
    await page.goto('/jobs/job-failing');
    await page.click('[data-testid="start-remediation-btn"]');
    await expect(page).toHaveURL('/remediation/job-failing');
  });

  test('MT-E2E-005: Back button returns to Jobs list', async ({ page }) => {
    await page.goto('/jobs/job-failing');
    await page.click('[data-testid="back-button"]');
    await expect(page).toHaveURL('/jobs');
  });

  test('MT-E2E-006: Raw data toggle expands and collapses', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    // Initially hidden
    await expect(page.locator('[data-testid="raw-json"]')).not.toBeVisible();

    // Click to show
    await page.click('[data-testid="raw-data-toggle"]');
    await expect(page.locator('[data-testid="raw-json"]')).toBeVisible();

    // Click to hide
    await page.click('[data-testid="raw-data-toggle"]');
    await expect(page.locator('[data-testid="raw-json"]')).not.toBeVisible();
  });

  test('MT-E2E-007: Filter issues by severity', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    // Get initial row count
    const initialRows = await page.locator('[data-testid="issue-row"]').count();

    // Filter by "serious" severity
    await page.selectOption('[data-testid="filter-severity"]', 'serious');

    // Verify filtered results
    const filteredRows = await page.locator('[data-testid="issue-row"]').count();
    expect(filteredRows).toBeLessThanOrEqual(initialRows);

    // All visible rows should be "serious"
    const severityBadges = page.locator('[data-testid="issue-row"] [data-testid^="severity-badge-"]');
    const count = await severityBadges.count();
    for (let i = 0; i < count; i++) {
      await expect(severityBadges.nth(i)).toContainText(/serious/i);
    }
  });

  test('MT-E2E-010: Deep link loads job correctly', async ({ page }) => {
    // Navigate directly to a specific job
    await page.goto('/jobs/job-failing');

    // Verify page loads with data
    await expect(page.locator('[data-testid="compliance-score"]')).toBeVisible();
    await expect(page.locator('[data-testid="issues-table"]')).toBeVisible();

    // Verify job-specific data is shown
    const scoreText = await page.locator('[data-testid="score-value"]').textContent();
    expect(scoreText).toBeTruthy();
  });
});
```

### Data Test IDs Required
Ensure these `data-testid` attributes exist in components:
- `view-job-btn` - View button in jobs list
- `compliance-score` - Score circle component
- `score-value` - Score number text
- `severity-summary` - Severity cards container
- `severity-card` - Individual severity card
- `issues-table` - Issues table
- `issues-table-container` - Scrollable table wrapper
- `issue-row` - Individual issue row
- `start-remediation-btn` - Start Remediation button
- `download-report-btn` - Download Report button
- `re-audit-btn` - Re-Audit button
- `back-button` - Back navigation button
- `raw-data-toggle` - Show/Hide Raw Data button
- `raw-json` - Raw JSON container
- `filter-severity` - Severity filter dropdown
- `severity-badge-*` - Severity badges (e.g., `severity-badge-serious`)
```

---

## Step 4: Accessibility Test Examples

**Target:** Frontend (`ninja-frontend/`)
**File:** `e2e/job-detail.a11y.ts`

```
## Task: Create Accessibility Tests for Job Detail View

Write Playwright tests with axe-core to validate WCAG 2.1 AA compliance.

### Location
Create file: `ninja-frontend/e2e/job-detail.a11y.ts`

### Dependencies
```bash
npm install -D @axe-core/playwright
```

### Test Cases to Implement

| Test ID | Test Case | Method | Expected |
|---------|-----------|--------|----------|
| MT-A11Y-001 | Keyboard navigation | Tab through page | All interactive elements focusable |
| MT-A11Y-002 | Focus visible | Tab through | Clear focus indicators |
| MT-A11Y-003 | Screen reader labels | Check ARIA | All elements have accessible names |
| MT-A11Y-004 | Color contrast | axe-core scan | No contrast violations |
| MT-A11Y-005 | Score announced | Check aria-label | "Compliance score X percent" |
| MT-A11Y-006 | Table accessible | Check structure | Headers with scope, caption |
| MT-A11Y-007 | Button labels | Check accessible names | Clear action descriptions |
| MT-A11Y-008 | Skip to content | Tab first | Skip link available |
| MT-A11Y-009 | No color-only info | Visual + ARIA | Icons accompany colors |
| MT-A11Y-010 | Zoom to 200% | CSS zoom | No content loss or overlap |

### Test Implementation

```typescript
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Job Detail View - Accessibility Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('MT-A11Y-004: no axe-core WCAG violations', async ({ page }) => {
    await page.goto('/jobs/job-failing');
    await page.waitForSelector('[data-testid="compliance-score"]');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .exclude('[data-testid="raw-json"]') // Exclude code blocks
      .analyze();

    // Log violations for debugging
    if (results.violations.length > 0) {
      console.log('Accessibility violations:');
      results.violations.forEach(v => {
        console.log(`- ${v.id}: ${v.description}`);
        console.log(`  Impact: ${v.impact}`);
        console.log(`  Nodes: ${v.nodes.length}`);
      });
    }

    expect(results.violations).toEqual([]);
  });

  test('MT-A11Y-001: all interactive elements are keyboard accessible', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    const interactiveSelectors = [
      '[data-testid="back-button"]',
      '[data-testid="start-remediation-btn"]',
      '[data-testid="download-report-btn"]',
      '[data-testid="re-audit-btn"]',
      '[data-testid="raw-data-toggle"]',
    ];

    for (const selector of interactiveSelectors) {
      const element = page.locator(selector);

      // Element should exist
      await expect(element).toBeVisible();

      // Element should be focusable (not have tabindex="-1")
      const tabIndex = await element.getAttribute('tabindex');
      expect(tabIndex).not.toBe('-1');

      // Element should be reachable via keyboard
      await element.focus();
      const isFocused = await element.evaluate(el => el === document.activeElement);
      expect(isFocused).toBe(true);
    }
  });

  test('MT-A11Y-002: focus indicators are visible', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    // Tab to first interactive element
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    const focusedElement = page.locator(':focus');

    // Check for visible focus style
    const styles = await focusedElement.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        outline: computed.outline,
        outlineWidth: computed.outlineWidth,
        outlineStyle: computed.outlineStyle,
        boxShadow: computed.boxShadow,
      };
    });

    const hasFocusIndicator =
      (styles.outlineStyle !== 'none' && styles.outlineWidth !== '0px') ||
      styles.boxShadow !== 'none';

    expect(hasFocusIndicator).toBe(true);
  });

  test('MT-A11Y-005: compliance score has accessible label', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    const scoreElement = page.locator('[data-testid="compliance-score"]');

    // Should have aria-label or aria-labelledby
    const ariaLabel = await scoreElement.getAttribute('aria-label');
    const ariaLabelledBy = await scoreElement.getAttribute('aria-labelledby');
    const role = await scoreElement.getAttribute('role');

    // Must have accessible name
    expect(ariaLabel || ariaLabelledBy).toBeTruthy();

    // If has aria-label, verify format
    if (ariaLabel) {
      expect(ariaLabel.toLowerCase()).toMatch(/compliance score \d+/);
    }

    // Should have appropriate role
    expect(['img', 'figure', 'meter', 'progressbar']).toContain(role);
  });

  test('MT-A11Y-006: issues table is properly structured', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    const table = page.locator('[data-testid="issues-table"]');

    // Table should exist
    await expect(table).toBeVisible();

    // Should have proper role
    const role = await table.evaluate(el => el.tagName.toLowerCase());
    expect(role).toBe('table');

    // Headers should have scope attribute
    const headers = table.locator('th');
    const headerCount = await headers.count();
    expect(headerCount).toBeGreaterThan(0);

    for (let i = 0; i < headerCount; i++) {
      const scope = await headers.nth(i).getAttribute('scope');
      expect(['col', 'row', 'colgroup', 'rowgroup']).toContain(scope);
    }

    // Table should have caption or aria-label for context
    const caption = table.locator('caption');
    const tableAriaLabel = await table.getAttribute('aria-label');
    const tableAriaLabelledBy = await table.getAttribute('aria-labelledby');

    const hasAccessibleName =
      (await caption.count()) > 0 ||
      tableAriaLabel ||
      tableAriaLabelledBy;

    expect(hasAccessibleName).toBeTruthy();
  });

  test('MT-A11Y-009: severity indicators use icons, not just color', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    const severityBadges = page.locator('[data-testid^="severity-badge-"]');
    const count = await severityBadges.count();

    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(count, 4); i++) {
      const badge = severityBadges.nth(i);

      // Should have an icon (svg, img, or element with role="img")
      const hasIcon = await badge.locator('svg, img, [role="img"]').count();
      expect(hasIcon).toBeGreaterThan(0);

      // Should have visible text label
      const text = await badge.textContent();
      expect(text?.trim().length).toBeGreaterThan(0);
    }
  });

  test('MT-A11Y-010: content remains accessible at 200% zoom', async ({ page }) => {
    await page.goto('/jobs/job-failing');

    // Simulate 200% zoom by halving viewport
    await page.setViewportSize({ width: 640, height: 360 });

    // Key content should remain visible
    await expect(page.locator('[data-testid="compliance-score"]')).toBeVisible();
    await expect(page.locator('[data-testid="severity-summary"]')).toBeVisible();
    await expect(page.locator('[data-testid="issues-table"]')).toBeVisible();

    // No horizontal scrollbar on body (tables may scroll independently)
    const bodyOverflows = await page.evaluate(() => {
      return document.body.scrollWidth > document.body.clientWidth;
    });
    expect(bodyOverflows).toBe(false);

    // Run axe at zoomed state
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
```

### axe-core Tags Reference
| Tag | Description |
|-----|-------------|
| `wcag2a` | WCAG 2.0 Level A |
| `wcag2aa` | WCAG 2.0 Level AA |
| `wcag21aa` | WCAG 2.1 Level AA |
| `best-practice` | Best practices (optional) |
| `section508` | Section 508 requirements |
```

---

## Step 5: Responsive Test Examples

**Target:** Frontend (`ninja-frontend/`)
**File:** `e2e/job-detail.responsive.ts`

```
## Task: Create Responsive Design Tests for Job Detail View

Write Playwright tests to validate layouts across mobile, tablet, and desktop viewports.

### Location
Create file: `ninja-frontend/e2e/job-detail.responsive.ts`

### Viewport Definitions
| Device | Width | Height | Use Case |
|--------|-------|--------|----------|
| Mobile | 375px | 667px | iPhone SE/8 |
| Tablet | 768px | 1024px | iPad |
| Desktop | 1280px | 800px | Standard desktop |
| Large Desktop | 1920px | 1080px | Full HD |

### Test Cases to Implement

| Test ID | Test Case | Viewport | Expected Behavior |
|---------|-----------|----------|-------------------|
| MT-RD-001 | Mobile layout | 375px | Single column, stacked cards |
| MT-RD-002 | Tablet layout | 768px | 2-column severity cards |
| MT-RD-003 | Desktop layout | 1280px | Full 4-column layout |
| MT-RD-004 | Table horizontal scroll | 375px | Table scrollable, not squished |
| MT-RD-005 | Action buttons stack | 375px | Buttons full-width, vertical |
| MT-RD-006 | Score circle scales | All | Readable at all sizes |
| MT-RD-007 | Text truncation | 375px | Long text truncated properly |

### Test Implementation

```typescript
import { test, expect } from '@playwright/test';

test.describe('Job Detail View - Responsive Design', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('MT-RD-001: mobile shows single column layout', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/jobs/job-failing');

    const cards = page.locator('[data-testid="severity-card"]');
    const count = await cards.count();

    if (count >= 2) {
      const firstBox = await cards.first().boundingBox();
      const secondBox = await cards.nth(1).boundingBox();

      // Cards should stack vertically (second card below first)
      expect(secondBox!.y).toBeGreaterThan(firstBox!.y + firstBox!.height - 10);

      // Cards should be nearly full width
      const containerWidth = await page.locator('[data-testid="severity-summary"]')
        .evaluate(el => el.clientWidth);
      expect(firstBox!.width).toBeGreaterThan(containerWidth * 0.4);
    }
  });

  test('MT-RD-002: tablet shows 2-column severity cards', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/jobs/job-failing');

    const cards = page.locator('[data-testid="severity-card"]');
    const count = await cards.count();

    if (count >= 2) {
      const firstBox = await cards.first().boundingBox();
      const secondBox = await cards.nth(1).boundingBox();

      // First two cards should be side by side (similar Y position)
      expect(Math.abs(firstBox!.y - secondBox!.y)).toBeLessThan(10);

      // Cards should not overlap horizontally
      expect(secondBox!.x).toBeGreaterThan(firstBox!.x + firstBox!.width - 10);
    }
  });

  test('MT-RD-003: desktop shows 4-column severity cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/jobs/job-failing');

    const cards = page.locator('[data-testid="severity-card"]');
    const count = await cards.count();
    expect(count).toBe(4);

    // Get all card positions
    const boxes = await Promise.all(
      [0, 1, 2, 3].map(i => cards.nth(i).boundingBox())
    );

    // All 4 cards should be on the same row (same Y position)
    const firstY = boxes[0]!.y;
    boxes.forEach(box => {
      expect(Math.abs(box!.y - firstY)).toBeLessThan(5);
    });

    // Cards should be evenly distributed
    const widths = boxes.map(b => b!.width);
    const avgWidth = widths.reduce((a, b) => a + b, 0) / 4;
    widths.forEach(w => {
      expect(Math.abs(w - avgWidth)).toBeLessThan(avgWidth * 0.25);
    });
  });

  test('MT-RD-004: table has horizontal scroll on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/jobs/job-failing');

    const tableContainer = page.locator('[data-testid="issues-table-container"]');

    // Container should have overflow-x: auto or scroll
    const overflowX = await tableContainer.evaluate(
      el => window.getComputedStyle(el).overflowX
    );
    expect(['auto', 'scroll']).toContain(overflowX);
  });

  test('MT-RD-005: action buttons stack on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/jobs/job-failing');

    const actionsContainer = page.locator('[data-testid="job-actions"]');
    const buttons = actionsContainer.locator('button');
    const count = await buttons.count();

    if (count >= 2) {
      const firstBox = await buttons.first().boundingBox();
      const secondBox = await buttons.nth(1).boundingBox();

      // Buttons should stack vertically
      expect(secondBox!.y).toBeGreaterThan(firstBox!.y + firstBox!.height - 10);

      // Buttons should be full width (or nearly)
      const containerWidth = await actionsContainer.evaluate(el => el.clientWidth);
      expect(firstBox!.width).toBeGreaterThan(containerWidth * 0.9);
    }
  });

  test('MT-RD-006: compliance score is readable at all viewport sizes', async ({ page }) => {
    const viewports = [
      { width: 375, height: 667, name: 'mobile' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 1280, height: 800, name: 'desktop' },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/jobs/job-failing');

      const score = page.locator('[data-testid="compliance-score"]');
      await expect(score).toBeVisible();

      const box = await score.boundingBox();

      // Score should be at least 80px in both dimensions for readability
      expect(box!.width).toBeGreaterThanOrEqual(80);
      expect(box!.height).toBeGreaterThanOrEqual(80);

      // Score text should be visible
      const scoreText = score.locator('[data-testid="score-value"]');
      await expect(scoreText).toBeVisible();
    }
  });

  test('MT-RD-007: long text is truncated on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/jobs/job-failing');

    const descriptionCells = page.locator('[data-testid="issue-description"]');
    const count = await descriptionCells.count();

    for (let i = 0; i < Math.min(count, 3); i++) {
      const cell = descriptionCells.nth(i);

      // Check CSS truncation properties
      const styles = await cell.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return {
          textOverflow: computed.textOverflow,
          overflow: computed.overflow,
          whiteSpace: computed.whiteSpace,
        };
      });

      // Should have text truncation CSS or fit within viewport
      const box = await cell.boundingBox();
      expect(box!.width).toBeLessThan(375);
    }
  });
});
```

### CSS Classes to Verify
Ensure these Tailwind responsive classes are used in components:
- `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` - Severity cards grid
- `flex-col md:flex-row` - Action buttons layout
- `overflow-x-auto` - Table container
- `truncate` or `line-clamp-*` - Long text handling
- `w-full md:w-auto` - Button widths
```

---

## Step 6a: Frontend Test Scripts

**Target:** Frontend (`ninja-frontend/`)
**Files:** `package.json`, `vitest.config.ts`, `src/test/setup.ts`

```
## Task: Add Test Scripts and Configuration to Frontend

Update package.json with comprehensive test scripts and configure Vitest for unit testing.

### Location
Modify: `ninja-frontend/package.json`
Create: `ninja-frontend/vitest.config.ts`
Create: `ninja-frontend/src/test/setup.ts`

### 1. Package.json Scripts

Add these scripts to `ninja-frontend/package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint src --ext ts,tsx",
    "type-check": "tsc --noEmit",

    "test": "vitest",
    "test:ci": "vitest run --reporter=junit --outputFile=test-results/junit.xml",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest watch",
    "test:ui": "vitest --ui",

    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:chromium": "playwright test --project=chromium",
    "test:e2e:firefox": "playwright test --project=firefox",
    "test:e2e:webkit": "playwright test --project=webkit",

    "test:a11y": "playwright test --project=accessibility",
    "test:a11y:report": "playwright test --project=accessibility --reporter=html",

    "test:responsive": "playwright test --project=mobile-chrome --project=mobile-safari --project=tablet",

    "test:visual": "playwright test --project=visual",
    "test:visual:update": "playwright test --project=visual --update-snapshots",

    "test:all": "npm run test:ci && npm run test:e2e",
    "test:full": "npm run test:ci && npm run test:e2e && npm run test:a11y",

    "playwright:install": "playwright install --with-deps",
    "playwright:report": "playwright show-report"
  }
}
```

### 2. Dependencies to Add

```json
{
  "devDependencies": {
    "@playwright/test": "^1.40.0",
    "@axe-core/playwright": "^4.8.0",
    "@testing-library/jest-dom": "^6.1.0",
    "@testing-library/react": "^14.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@vitest/coverage-v8": "^1.0.0",
    "@vitest/ui": "^1.0.0",
    "jsdom": "^23.0.0",
    "vitest": "^1.0.0",
    "msw": "^2.0.0"
  }
}
```

### 3. Vitest Configuration

Create `ninja-frontend/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: ['e2e/**/*', 'node_modules/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/test/**/*',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        global: {
          branches: 70,
          functions: 75,
          lines: 80,
          statements: 80,
        },
      },
    },
    reporters: ['default'],
    outputFile: {
      junit: './test-results/junit.xml',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### 4. Test Setup File

Create `ninja-frontend/src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia for responsive components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Suppress console errors in tests (optional)
// vi.spyOn(console, 'error').mockImplementation(() => {});
```

### 5. Gitignore Updates

Add to `.gitignore`:
```
# Test outputs
coverage/
test-results/
playwright-report/
playwright/.cache/
```
```

---

## Step 6b: Backend Test Scripts

**Target:** Backend (`ninja-backend/`)
**Files:** `package.json`, `vitest.config.ts`, `vitest.unit.config.ts`, `vitest.integration.config.ts`

```
## Task: Add Test Scripts and Configuration to Backend

Update package.json with comprehensive test scripts and configure Vitest for unit and integration testing.

### Location
Modify: `ninja-backend/package.json`
Create: `ninja-backend/vitest.config.ts`
Create: `ninja-backend/vitest.unit.config.ts`
Create: `ninja-backend/vitest.integration.config.ts`
Create: `ninja-backend/src/test/unit-setup.ts`
Create: `ninja-backend/src/test/integration-setup.ts`

### 1. Package.json Scripts

Add these scripts to `ninja-backend/package.json`:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src --ext .ts",
    "type-check": "tsc --noEmit",

    "test": "vitest",
    "test:ci": "vitest run --reporter=junit --outputFile=test-results/junit.xml --coverage",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest watch",

    "test:unit": "vitest run --config vitest.unit.config.ts",
    "test:unit:watch": "vitest watch --config vitest.unit.config.ts",
    "test:unit:coverage": "vitest run --config vitest.unit.config.ts --coverage",

    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:integration:watch": "vitest watch --config vitest.integration.config.ts",
    "test:integration:coverage": "vitest run --config vitest.integration.config.ts --coverage",

    "test:db:setup": "prisma migrate deploy && prisma db seed",
    "test:db:reset": "prisma migrate reset --force",

    "test:all": "npm run test:unit && npm run test:integration"
  }
}
```

### 2. Dependencies to Add

```json
{
  "devDependencies": {
    "vitest": "^1.0.0",
    "@vitest/coverage-v8": "^1.0.0",
    "supertest": "^6.3.0",
    "@types/supertest": "^6.0.0",
    "msw": "^2.0.0"
  }
}
```

### 3. Base Vitest Configuration

Create `ninja-backend/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test/**/*',
        'src/prisma/**/*',
        'src/types/**/*',
      ],
    },
  },
});
```

### 4. Unit Test Configuration

Create `ninja-backend/vitest.unit.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.{test,spec}.ts'],
    exclude: ['src/**/*.integration.{test,spec}.ts', 'node_modules', 'dist'],
    setupFiles: ['./src/test/unit-setup.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/unit',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test/**/*',
        'src/prisma/**/*',
      ],
      thresholds: {
        global: {
          branches: 70,
          functions: 75,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
```

### 5. Integration Test Configuration

Create `ninja-backend/vitest.integration.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./src/test/integration-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Run tests serially for database isolation
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage/integration',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test/**/*',
        'src/prisma/**/*',
      ],
      thresholds: {
        global: {
          branches: 60,
          functions: 65,
          lines: 70,
          statements: 70,
        },
      },
    },
  },
});
```

### 6. Unit Test Setup

Create `ninja-backend/src/test/unit-setup.ts`:

```typescript
import { vi, beforeEach, afterEach } from 'vitest';

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after each test
afterEach(() => {
  vi.restoreAllMocks();
});

// Mock external services
vi.mock('../lib/prisma', () => ({
  prisma: {
    job: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // Add other models as needed
  },
}));
```

### 7. Integration Test Setup

Create `ninja-backend/src/test/integration-setup.ts`:

```typescript
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

beforeAll(async () => {
  // Connect to test database
  await prisma.$connect();
  console.log('Connected to test database');
});

afterAll(async () => {
  // Disconnect from database
  await prisma.$disconnect();
  console.log('Disconnected from test database');
});

beforeEach(async () => {
  // Optional: Clean up specific tables before each test
  // await prisma.job.deleteMany();
});

afterEach(async () => {
  // Optional: Clean up after each test
});

// Export prisma client for use in tests
export { prisma };
```

### 8. Gitignore Updates

Add to `.gitignore`:
```
# Test outputs
coverage/
test-results/
```
```

---

## Step 7: Test Coverage Gates (Codecov)

**Target:** Repository Root
**File:** `codecov.yml`

```
## Task: Configure Codecov for Test Coverage Enforcement

Create a Codecov configuration file to enforce minimum coverage thresholds and track coverage by component.

### Location
Create file: `codecov.yml` (repository root)

### Configuration Content

```yaml
# Codecov Configuration for Ninja Platform
# Documentation: https://docs.codecov.com/docs/codecov-yaml

codecov:
  require_ci_to_pass: yes
  notify:
    wait_for_ci: yes

coverage:
  precision: 2
  round: down
  range: "70...100"

  status:
    # Overall project coverage requirements
    project:
      default:
        target: 75%
        threshold: 2%
        if_ci_failed: error
        only_pulls: false

    # Coverage on changed lines only (for PRs)
    patch:
      default:
        target: 80%
        threshold: 5%
        if_ci_failed: error

  # Component-specific coverage flags
  flags:
    frontend-unit:
      paths:
        - ninja-frontend/src/
      carryforward: true
      target: 80%

    backend-unit:
      paths:
        - ninja-backend/src/
      carryforward: true
      target: 80%

    integration:
      paths:
        - ninja-backend/src/
      carryforward: true
      target: 70%

    e2e:
      paths:
        - ninja-frontend/src/
      carryforward: true
      target: 60%

# Files to ignore in coverage calculations
ignore:
  - "**/*.d.ts"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "**/test/**"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/e2e/**"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"
  - "**/coverage/**"
  - "**/*.config.ts"
  - "**/*.config.js"
  - "**/prisma/migrations/**"
  - "**/prisma/seed.ts"

# PR comment configuration
comment:
  layout: "reach,diff,flags,files"
  behavior: default
  require_changes: true
  require_base: false
  require_head: true
  branches:
    - main
    - develop

# GitHub Checks integration
github_checks:
  annotations: true
```

### GitHub Actions Integration

Update your CI workflow to upload coverage:

```yaml
# In .github/workflows/ci.yml

- name: Upload Frontend Coverage to Codecov
  uses: codecov/codecov-action@v4
  with:
    token: ${{ secrets.CODECOV_TOKEN }}
    files: ninja-frontend/coverage/lcov.info
    flags: frontend-unit
    name: frontend-coverage
    fail_ci_if_error: true
    verbose: true

- name: Upload Backend Coverage to Codecov
  uses: codecov/codecov-action@v4
  with:
    token: ${{ secrets.CODECOV_TOKEN }}
    files: ninja-backend/coverage/lcov.info
    flags: backend-unit
    name: backend-coverage
    fail_ci_if_error: true
    verbose: true

- name: Upload Integration Coverage to Codecov
  uses: codecov/codecov-action@v4
  with:
    token: ${{ secrets.CODECOV_TOKEN }}
    files: ninja-backend/coverage/integration/lcov.info
    flags: integration
    name: integration-coverage
    fail_ci_if_error: true
```

### Setup Steps

1. **Connect Repository to Codecov:**
   - Go to https://codecov.io
   - Sign in with GitHub
   - Add your repository
   - Copy the upload token

2. **Add GitHub Secret:**
   - Go to repository Settings → Secrets → Actions
   - Add `CODECOV_TOKEN` with the value from Codecov

3. **Add Badge to README.md:**
```markdown
[![codecov](https://codecov.io/gh/s4cindia/ninja-platform/branch/main/graph/badge.svg?token=YOUR_TOKEN)](https://codecov.io/gh/s4cindia/ninja-platform)
```

### Coverage Thresholds Summary

| Component | Target | Threshold | Enforcement |
|-----------|--------|-----------|-------------|
| Overall Project | 75% | 2% drop allowed | Block PR |
| New Code (Patch) | 80% | 5% drop allowed | Block PR |
| Frontend Unit | 80% | - | Flag only |
| Backend Unit | 80% | - | Flag only |
| Integration | 70% | - | Flag only |
| E2E | 60% | - | Flag only |
```

---

## Step 8: PR Template

**Target:** Repository Root
**Files:** `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/`

```
## Task: Create Pull Request and Issue Templates

Create GitHub templates for pull requests and issues with test checklists.

### Location
Create: `.github/PULL_REQUEST_TEMPLATE.md`
Create: `.github/ISSUE_TEMPLATE/bug_report.md`
Create: `.github/ISSUE_TEMPLATE/feature_request.md`

### 1. Pull Request Template

Create `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Description
<!-- Describe your changes in detail -->

## Related Issue
<!-- Link to the issue this PR addresses: Fixes #123 -->

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing functionality)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Test addition/update

---

## Testing Checklist

### Automated Tests
- [ ] All unit tests pass (`npm run test:ci`)
- [ ] Integration tests pass (`npm run test:integration`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] Accessibility tests pass (`npm run test:a11y`)
- [ ] Code coverage meets thresholds (≥75%)

### Manual Testing (Required for UI Changes)

#### UI/UX Tests
- [ ] MT-UX-001: Visual hierarchy is clear and scannable
- [ ] MT-UX-002: Color coding is intuitive (red=bad, green=good)
- [ ] MT-UX-003: Action buttons are easily discoverable
- [ ] MT-UX-004: Loading states provide feedback
- [ ] MT-UX-005: Error messages are helpful and actionable
- [ ] MT-UX-006: Empty states have clear messaging
- [ ] MT-UX-007: Animations are smooth (no jank)
- [ ] MT-UX-008: Sort/filter indicators are visible

#### Responsive Design
- [ ] MT-RD-001: Mobile layout (375px) displays correctly
- [ ] MT-RD-002: Tablet layout (768px) displays correctly
- [ ] MT-RD-003: Desktop layout (1280px) displays correctly
- [ ] MT-RD-004: Tables scroll horizontally on mobile
- [ ] MT-RD-005: Buttons stack vertically on mobile

#### Accessibility
- [ ] MT-A11Y-001: All elements keyboard navigable
- [ ] MT-A11Y-002: Focus indicators are visible
- [ ] MT-A11Y-004: No color contrast violations
- [ ] MT-A11Y-009: Icons accompany color indicators

#### Browser Testing (For Significant UI Changes)
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)

---

## Screenshots/Videos

### Before
<!-- Screenshot of previous behavior (if applicable) -->

### After
<!-- Screenshot of new behavior -->

---

## Deployment Notes
<!-- Any special deployment considerations -->

---

## Checklist
- [ ] My code follows the project style guidelines
- [ ] I have performed a self-review
- [ ] I have added comments where necessary
- [ ] I have updated documentation (if applicable)
- [ ] My changes generate no new warnings
- [ ] I have added tests proving my fix/feature works
- [ ] New and existing tests pass locally
- [ ] Dependent changes have been merged

---

## Reviewer Notes
<!-- Specific areas you'd like reviewers to focus on -->
```

### 2. Bug Report Template

Create `.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug Report
about: Report a bug to help us improve
title: '[BUG] '
labels: bug
assignees: ''
---

## Bug Description
<!-- A clear and concise description of the bug -->

## Steps to Reproduce
1. Go to '...'
2. Click on '...'
3. Scroll down to '...'
4. See error

## Expected Behavior
<!-- What you expected to happen -->

## Actual Behavior
<!-- What actually happened -->

## Screenshots
<!-- If applicable, add screenshots to help explain -->

## Environment
- **OS:** [e.g., Windows 11, macOS 14, Ubuntu 22.04]
- **Browser:** [e.g., Chrome 120, Firefox 121, Safari 17]
- **App Version:** [e.g., 1.0.0]
- **Screen Size:** [e.g., Desktop 1920x1080, Mobile 375x667]

## Console Errors
<!-- Any errors from browser developer tools -->
```
<paste console errors here>
```

## Additional Context
<!-- Add any other context about the problem -->

## Possible Solution
<!-- If you have suggestions on how to fix -->
```

### 3. Feature Request Template

Create `.github/ISSUE_TEMPLATE/feature_request.md`:

```markdown
---
name: Feature Request
about: Suggest a new feature or improvement
title: '[FEATURE] '
labels: enhancement
assignees: ''
---

## Problem Statement
<!-- Describe the problem this feature would solve -->
<!-- Example: "As a user, I need to... because..." -->

## Proposed Solution
<!-- Describe your proposed solution -->

## Alternative Solutions
<!-- Describe alternatives you've considered -->

## User Story
<!-- Optional: Write as a user story -->
As a [type of user],
I want [goal/desire]
So that [benefit/value]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Mockups/Wireframes
<!-- If applicable, add visual mockups -->

## Technical Considerations
<!-- Any technical constraints or dependencies -->

## Priority
- [ ] Critical (blocking other work)
- [ ] High (needed soon)
- [ ] Medium (nice to have)
- [ ] Low (future consideration)

## Additional Context
<!-- Add any other context or screenshots -->
```

### 4. Issue Template Config

Create `.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
contact_links:
  - name: Documentation
    url: https://github.com/s4cindia/ninja-platform/wiki
    about: Check our documentation before opening an issue
  - name: Discussions
    url: https://github.com/s4cindia/ninja-platform/discussions
    about: Ask questions and discuss ideas
```
```

---

## Quick Reference: Commands by Step

| Step | Commands to Run |
|------|-----------------|
| 1 | N/A (create file manually) |
| 2 | `npm install -D @playwright/test @axe-core/playwright && npx playwright install` |
| 3-5 | Create test files in `e2e/` folder |
| 6a | `npm install -D vitest @vitest/coverage-v8 @vitest/ui @testing-library/react @testing-library/jest-dom jsdom` |
| 6b | `npm install -D vitest @vitest/coverage-v8 supertest @types/supertest` |
| 7 | Connect repo to codecov.io, add `CODECOV_TOKEN` secret |
| 8 | N/A (create files manually) |

---

*Created: January 2026*
*Project: Ninja Platform - Accessibility Validation SaaS*
