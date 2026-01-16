# Job Detail View - Test Cases

## Related Feature
Job Detail View - Replace Raw JSON with User-Friendly UI

---

## Test Summary

| Category | Automated | Manual | Total |
|----------|-----------|--------|-------|
| Unit Tests | 35 | 0 | 35 |
| Integration Tests | 6 | 0 | 6 |
| API Tests | 7 | 0 | 7 |
| UI/UX Tests | 0 | 8 | 8 |
| Responsive Tests | 0 | 7 | 7 |
| Accessibility Tests | 0 | 10 | 10 |
| Cross-Browser Tests | 0 | 6 | 6 |
| E2E Tests | 0 | 10 | 10 |
| Edge Case Tests | 0 | 10 | 10 |
| **Total** | **48** | **51** | **99** |

---

## Automated Tests

### Unit Tests (Vitest/Jest)

#### 1. ComplianceScore Component

| Test ID | Test Case | Input | Expected Output |
|---------|-----------|-------|-----------------|
| UT-CS-001 | Renders score value correctly | `score: 66` | Displays "66" in center |
| UT-CS-002 | Green color for high score | `score: 95` | Uses `#22c55e` stroke color |
| UT-CS-003 | Yellow color for medium score | `score: 75` | Uses `#eab308` stroke color |
| UT-CS-004 | Red color for low score | `score: 45` | Uses `#ef4444` stroke color |
| UT-CS-005 | Boundary: score 90 is green | `score: 90` | Uses green color |
| UT-CS-006 | Boundary: score 89 is yellow | `score: 89` | Uses yellow color |
| UT-CS-007 | Boundary: score 70 is yellow | `score: 70` | Uses yellow color |
| UT-CS-008 | Boundary: score 69 is red | `score: 69` | Uses red color |
| UT-CS-009 | Score 0 renders correctly | `score: 0` | Displays "0", red color |
| UT-CS-010 | Score 100 renders full circle | `score: 100` | Full stroke, green |

**Example Test Code:**
```typescript
// src/components/jobs/__tests__/ComplianceScore.test.tsx
import { render, screen } from '@testing-library/react';
import { ComplianceScore } from '../ComplianceScore';

describe('ComplianceScore', () => {
  it('displays the correct score value', () => {
    render(<ComplianceScore score={66} />);
    expect(screen.getByText('66')).toBeInTheDocument();
  });

  it('uses green color for scores >= 90', () => {
    const { container } = render(<ComplianceScore score={95} />);
    const circle = container.querySelector('circle[stroke]');
    expect(circle).toHaveAttribute('stroke', '#22c55e');
  });

  it('uses yellow color for scores 70-89', () => {
    const { container } = render(<ComplianceScore score={75} />);
    const circle = container.querySelector('circle[stroke]');
    expect(circle).toHaveAttribute('stroke', '#eab308');
  });

  it('uses red color for scores < 70', () => {
    const { container } = render(<ComplianceScore score={45} />);
    const circle = container.querySelector('circle[stroke]');
    expect(circle).toHaveAttribute('stroke', '#ef4444');
  });
});
```

---

#### 2. SeveritySummary Component

| Test ID | Test Case | Input | Expected Output |
|---------|-----------|-------|-----------------|
| UT-SS-001 | Renders all 4 severity cards | `summary: {...}` | 4 cards visible |
| UT-SS-002 | Critical count displayed | `critical: 5` | Shows "5" in critical card |
| UT-SS-003 | Serious count displayed | `serious: 3` | Shows "3" in serious card |
| UT-SS-004 | Moderate count displayed | `moderate: 2` | Shows "2" in moderate card |
| UT-SS-005 | Minor count displayed | `minor: 1` | Shows "1" in minor card |
| UT-SS-006 | Zero counts render as "0" | `critical: 0` | Shows "0", not empty |
| UT-SS-007 | Critical card has red styling | - | Has `bg-red-50` class |
| UT-SS-008 | Serious card has orange styling | - | Has `bg-orange-50` class |
| UT-SS-009 | Moderate card has yellow styling | - | Has `bg-yellow-50` class |
| UT-SS-010 | Minor card has blue styling | - | Has `bg-blue-50` class |

**Example Test Code:**
```typescript
// src/components/jobs/__tests__/SeveritySummary.test.tsx
import { render, screen } from '@testing-library/react';
import { SeveritySummary } from '../SeveritySummary';

const mockSummary = {
  total: 7,
  critical: 0,
  serious: 3,
  moderate: 2,
  minor: 2
};

describe('SeveritySummary', () => {
  it('renders all four severity cards', () => {
    render(<SeveritySummary summary={mockSummary} />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Serious')).toBeInTheDocument();
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    expect(screen.getByText('Minor')).toBeInTheDocument();
  });

  it('displays correct counts for each severity', () => {
    render(<SeveritySummary summary={mockSummary} />);
    expect(screen.getByTestId('critical-count')).toHaveTextContent('0');
    expect(screen.getByTestId('serious-count')).toHaveTextContent('3');
    expect(screen.getByTestId('moderate-count')).toHaveTextContent('2');
    expect(screen.getByTestId('minor-count')).toHaveTextContent('2');
  });
});
```

---

#### 3. IssuesTable Component

| Test ID | Test Case | Input | Expected Output |
|---------|-----------|-------|-----------------|
| UT-IT-001 | Renders table headers | `issues: [...]` | Severity, Description, Location, Auto-Fix columns |
| UT-IT-002 | Renders correct number of rows | 7 issues | 7 table rows |
| UT-IT-003 | Empty state message | `issues: []` | "No issues found" message |
| UT-IT-004 | Severity badge color - critical | `severity: 'critical'` | Red badge |
| UT-IT-005 | Severity badge color - serious | `severity: 'serious'` | Orange badge |
| UT-IT-006 | Severity badge color - moderate | `severity: 'moderate'` | Yellow badge |
| UT-IT-007 | Severity badge color - minor | `severity: 'minor'` | Blue badge |
| UT-IT-008 | Auto-fix true shows checkmark | `autoFixable: true` | Checkmark icon visible |
| UT-IT-009 | Auto-fix false shows X | `autoFixable: false` | X icon visible |
| UT-IT-010 | Description text renders | `description: 'Missing alt'` | Text visible |
| UT-IT-011 | Location path renders | `location: 'ch1.xhtml'` | Path visible |
| UT-IT-012 | Long description truncates | 200+ char description | Truncated with ellipsis |

**Example Test Code:**
```typescript
// src/components/jobs/__tests__/IssuesTable.test.tsx
import { render, screen } from '@testing-library/react';
import { IssuesTable } from '../IssuesTable';

const mockIssues = [
  {
    id: '1',
    severity: 'serious',
    description: 'Missing alt text on image',
    location: 'OEBPS/chapter1.xhtml',
    autoFixable: true
  },
  {
    id: '2',
    severity: 'minor',
    description: 'Heading hierarchy skip',
    location: 'OEBPS/chapter2.xhtml',
    autoFixable: false
  }
];

describe('IssuesTable', () => {
  it('renders table with correct headers', () => {
    render(<IssuesTable issues={mockIssues} />);
    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('Auto-Fix')).toBeInTheDocument();
  });

  it('renders correct number of issue rows', () => {
    render(<IssuesTable issues={mockIssues} />);
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 data rows
  });

  it('shows empty state when no issues', () => {
    render(<IssuesTable issues={[]} />);
    expect(screen.getByText(/no issues found/i)).toBeInTheDocument();
  });

  it('displays auto-fix indicator correctly', () => {
    render(<IssuesTable issues={mockIssues} />);
    const checkmarks = screen.getAllByTestId('autofix-yes');
    const crosses = screen.getAllByTestId('autofix-no');
    expect(checkmarks).toHaveLength(1);
    expect(crosses).toHaveLength(1);
  });
});
```

---

#### 4. JobActions Component

| Test ID | Test Case | Input | Expected Output |
|---------|-----------|-------|-----------------|
| UT-JA-001 | Renders all action buttons | - | 3 buttons visible |
| UT-JA-002 | Start Remediation button present | - | Button with text visible |
| UT-JA-003 | Download Report button present | - | Button with text visible |
| UT-JA-004 | Re-Audit button present | - | Button with text visible |
| UT-JA-005 | Start Remediation click calls handler | Click | `onStartRemediation` called |
| UT-JA-006 | Download Report click calls handler | Click | `onDownloadReport` called |
| UT-JA-007 | Re-Audit click calls handler | Click | `onReAudit` called |
| UT-JA-008 | Buttons disabled during loading | `loading: true` | All buttons disabled |

**Example Test Code:**
```typescript
// src/components/jobs/__tests__/JobActions.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { JobActions } from '../JobActions';

describe('JobActions', () => {
  const mockHandlers = {
    onStartRemediation: vi.fn(),
    onDownloadReport: vi.fn(),
    onReAudit: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all action buttons', () => {
    render(<JobActions {...mockHandlers} jobId="123" />);
    expect(screen.getByText(/start remediation/i)).toBeInTheDocument();
    expect(screen.getByText(/download report/i)).toBeInTheDocument();
    expect(screen.getByText(/re-audit/i)).toBeInTheDocument();
  });

  it('calls onStartRemediation when clicked', () => {
    render(<JobActions {...mockHandlers} jobId="123" />);
    fireEvent.click(screen.getByText(/start remediation/i));
    expect(mockHandlers.onStartRemediation).toHaveBeenCalledWith('123');
  });

  it('disables buttons when loading', () => {
    render(<JobActions {...mockHandlers} jobId="123" loading={true} />);
    expect(screen.getByText(/start remediation/i)).toBeDisabled();
  });
});
```

---

#### 5. Raw Data Toggle

| Test ID | Test Case | Input | Expected Output |
|---------|-----------|-------|-----------------|
| UT-RD-001 | Raw data hidden by default | - | JSON not visible |
| UT-RD-002 | Toggle shows raw data | Click toggle | JSON visible |
| UT-RD-003 | Toggle hides raw data | Click toggle twice | JSON hidden |
| UT-RD-004 | JSON is formatted | `output: {...}` | Pretty-printed JSON |
| UT-RD-005 | Toggle text changes | Click | "Hide Raw Data" / "Show Raw Data" |

---

### Integration Tests

#### 6. JobDetail Page Integration

| Test ID | Test Case | Description | Expected Result |
|---------|-----------|-------------|-----------------|
| IT-JD-001 | Page loads with job data | Navigate to `/jobs/:id` | All sections render |
| IT-JD-002 | API data populates UI | Mock API response | Score, issues displayed |
| IT-JD-003 | Loading state shows spinner | API pending | Spinner visible |
| IT-JD-004 | Error state shows message | API error | Error alert visible |
| IT-JD-005 | Navigation to remediation | Click Start Remediation | URL changes to `/remediation/:id` |
| IT-JD-006 | Back button navigates | Click Back | Returns to Jobs list |

**Example Test Code:**
```typescript
// src/pages/__tests__/JobDetail.integration.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobDetail } from '../JobDetail';
import { rest } from 'msw';
import { setupServer } from 'msw/node';

const mockJobData = {
  jobId: '419590f4-7c9e-4946-9e61-3a79a93ad5b8',
  score: 66,
  isAccessible: false,
  summary: { total: 7, critical: 0, serious: 3, moderate: 2, minor: 2 },
  combinedIssues: []
};

const server = setupServer(
  rest.get('/api/v1/jobs/:id', (req, res, ctx) => {
    return res(ctx.json({ output: mockJobData }));
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('JobDetail Integration', () => {
  it('loads and displays job data', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/jobs/123']}>
          <Routes>
            <Route path="/jobs/:id" element={<JobDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('66')).toBeInTheDocument();
    });
  });
});
```

---

### API Tests (Backend - Vitest)

#### 7. GET /api/v1/jobs/:id Endpoint

| Test ID | Test Case | Input | Expected Result |
|---------|-----------|-------|-----------------|
| AT-GJ-001 | Returns job with valid ID | Valid UUID | 200 + job object |
| AT-GJ-002 | Returns 404 for invalid ID | Non-existent UUID | 404 error |
| AT-GJ-003 | Returns 401 without auth | No token | 401 Unauthorized |
| AT-GJ-004 | Tenant isolation | Other tenant's job ID | 404 Not Found |
| AT-GJ-005 | Output contains score | Completed job | `output.score` present |
| AT-GJ-006 | Output contains summary | Completed job | `output.summary` present |
| AT-GJ-007 | Output contains combinedIssues | Completed job | Array present |

**Example Test Code:**
```typescript
// src/controllers/__tests__/job.controller.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../app';

describe('GET /api/v1/jobs/:id', () => {
  it('returns job data for valid ID', async () => {
    const res = await request(app)
      .get('/api/v1/jobs/valid-job-id')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('output');
  });

  it('returns 404 for non-existent job', async () => {
    const res = await request(app)
      .get('/api/v1/jobs/non-existent-id')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .get('/api/v1/jobs/valid-job-id');

    expect(res.status).toBe(401);
  });
});
```

---

## Manual Tests

### UI/UX Testing

| Test ID | Test Case | Steps | Expected Result |
|---------|-----------|-------|-----------------|
| MT-UX-001 | Visual hierarchy clear | View job detail page | Score prominent, issues scannable |
| MT-UX-002 | Color coding intuitive | View severity cards | Red=bad, green=good obvious |
| MT-UX-003 | Action buttons discoverable | View page | Buttons clearly visible |
| MT-UX-004 | Loading feedback | Refresh page | Spinner while loading |
| MT-UX-005 | Error messages helpful | Simulate API error | Clear error message shown |
| MT-UX-006 | Empty state clear | View job with 0 issues | "No issues" message friendly |
| MT-UX-007 | Score circle animation | Page load | Smooth fill animation |
| MT-UX-008 | Table sorting visual | Click column header | Sort indicator visible |

---

### Responsive Design Testing

| Test ID | Test Case | Viewport | Expected Result |
|---------|-----------|----------|-----------------|
| MT-RD-001 | Mobile layout | 375px width | Single column, stacked cards |
| MT-RD-002 | Tablet layout | 768px width | 2-column severity cards |
| MT-RD-003 | Desktop layout | 1280px width | Full 4-column layout |
| MT-RD-004 | Table horizontal scroll | Mobile | Table scrollable, not squished |
| MT-RD-005 | Action buttons stack | Mobile | Buttons full-width, stacked |
| MT-RD-006 | Score circle scales | All viewports | Readable at all sizes |
| MT-RD-007 | Text truncation | Mobile | Long text truncated properly |

---

### Accessibility Testing (WCAG 2.1 AA)

| Test ID | Test Case | Tool/Method | Expected Result |
|---------|-----------|-------------|-----------------|
| MT-A11Y-001 | Keyboard navigation | Tab through page | All interactive elements focusable |
| MT-A11Y-002 | Focus visible | Tab through | Clear focus indicator |
| MT-A11Y-003 | Screen reader labels | NVDA/VoiceOver | All elements announced |
| MT-A11Y-004 | Color contrast | axe DevTools | No contrast violations |
| MT-A11Y-005 | Score announced | Screen reader | "Compliance score 66 percent" |
| MT-A11Y-006 | Table accessible | Screen reader | Headers announced with cells |
| MT-A11Y-007 | Button labels | Screen reader | Clear action descriptions |
| MT-A11Y-008 | Skip to content | Tab first | Skip link available |
| MT-A11Y-009 | No color-only info | Visual check | Icons + color for severity |
| MT-A11Y-010 | Zoom to 200% | Browser zoom | No content loss |

---

### Cross-Browser Testing

| Test ID | Test Case | Browser | Expected Result |
|---------|-----------|---------|-----------------|
| MT-CB-001 | Chrome latest | Chrome 120+ | All features work |
| MT-CB-002 | Firefox latest | Firefox 120+ | All features work |
| MT-CB-003 | Safari latest | Safari 17+ | All features work |
| MT-CB-004 | Edge latest | Edge 120+ | All features work |
| MT-CB-005 | SVG score circle | All browsers | Renders correctly |
| MT-CB-006 | CSS animations | All browsers | Smooth animations |

---

### Functional Testing (End-to-End)

| Test ID | Test Case | Steps | Expected Result |
|---------|-----------|-------|-----------------|
| MT-E2E-001 | Full user flow | Login -> Jobs -> View -> Remediate | Complete without errors |
| MT-E2E-002 | Start Remediation | Click button | Navigates to `/remediation/:id` |
| MT-E2E-003 | Download Report | Click button | File downloads (or placeholder) |
| MT-E2E-004 | Re-Audit | Click button | New audit job created |
| MT-E2E-005 | Back navigation | Click Back | Returns to Jobs list |
| MT-E2E-006 | Raw data toggle | Click Show/Hide | JSON expands/collapses |
| MT-E2E-007 | Filter issues | Select severity filter | Table filters correctly |
| MT-E2E-008 | Sort issues | Click column header | Table sorts correctly |
| MT-E2E-009 | Refresh page | F5 on job detail | Data persists correctly |
| MT-E2E-010 | Deep link | Direct URL to job | Page loads correctly |

---

### Edge Case Testing

| Test ID | Test Case | Condition | Expected Result |
|---------|-----------|-----------|-----------------|
| MT-EC-001 | Perfect score | `score: 100`, 0 issues | Green score, "No issues" |
| MT-EC-002 | Zero score | `score: 0`, many issues | Red score, all issues listed |
| MT-EC-003 | All critical issues | 10 critical issues | Red severity dominant |
| MT-EC-004 | Very long filename | 100+ char filename | Truncated with tooltip |
| MT-EC-005 | Very long description | 500+ char description | Truncated, expandable |
| MT-EC-006 | Special characters | Unicode in description | Renders correctly |
| MT-EC-007 | Missing output | Job still processing | "Processing" state shown |
| MT-EC-008 | Failed job | Job status FAILED | Error state, no score |
| MT-EC-009 | Cancelled job | Job status CANCELLED | Appropriate message |
| MT-EC-010 | 100+ issues | Large issue list | Pagination or scroll |

---

## Running Tests

### Frontend (ninja-frontend)
```bash
cd ninja-frontend

# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific test file
npm run test -- ComplianceScore.test.tsx

# Run in watch mode
npm run test:watch
```

### Backend (ninja-backend)
```bash
cd ninja-backend

# Run all tests
npm run test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run with coverage
npm run test:coverage
```

---

## Test Data Setup

### Seed Data for Testing
```sql
-- Create test tenant
INSERT INTO "Tenant" (id, name, slug)
VALUES ('test-tenant-id', 'Test Tenant', 'test-tenant');

-- Create test user
INSERT INTO "User" (id, email, "tenantId")
VALUES ('test-user-id', 'test@example.com', 'test-tenant-id');

-- Create test jobs
INSERT INTO "Job" (id, "tenantId", "userId", type, status, output) VALUES
  ('job-perfect', 'test-tenant-id', 'test-user-id', 'EPUB_ACCESSIBILITY', 'COMPLETED',
   '{"score": 100, "isAccessible": true, "summary": {"total": 0, "critical": 0, "serious": 0, "moderate": 0, "minor": 0}, "combinedIssues": []}'),
  ('job-failing', 'test-tenant-id', 'test-user-id', 'EPUB_ACCESSIBILITY', 'COMPLETED',
   '{"score": 45, "isAccessible": false, "summary": {"total": 10, "critical": 2, "serious": 3, "moderate": 3, "minor": 2}, "combinedIssues": [...]}'),
  ('job-processing', 'test-tenant-id', 'test-user-id', 'EPUB_ACCESSIBILITY', 'PROCESSING', NULL);
```

---

## Test Coverage Requirements

| Category | Minimum Coverage |
|----------|-----------------|
| Unit Tests | 80% |
| Integration Tests | 70% |
| API Tests | 90% |
| Overall | 75% |

---

*Created: January 2026*
*Author: Claude Code*
*Project: Ninja Platform - Accessibility Validation SaaS*
