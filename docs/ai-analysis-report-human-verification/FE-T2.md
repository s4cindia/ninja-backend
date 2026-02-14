# Frontend Terminal 2 (FE-T2) - Action Plan & Verification UI

**Branch:** `feature/ai-report-frontend-2`
**Focus:** Action Plan, verification queue enhancements, testing guides
**Duration:** 10 weeks (3 phases)

---

## Responsibilities

- Action Plan section
- "Start Manual Testing" button
- Enhanced verification queue UI
- Testing guide modal
- Verification status updates
- Navigation integration

**Conflicts:** None - separate files from FE-T1

---

## Phase 1: Action Plan (Weeks 1-4)

### Action Plan Section

`src/components/reports/ActionPlanSection.tsx`:
```typescript
export const ActionPlanSection = ({ actionPlan, jobId }) => {
  const navigate = useNavigate();

  const handleStartTesting = async () => {
    const res = await verificationApi.initFromReport(jobId, {
      criteriaIds: actionPlan.phases[0].tasks.map(t => t.criterionId)
    });
    navigate(`/verification/${jobId}?session=${res.data.sessionId}`);
  };

  return (
    <section className="bg-white rounded-lg shadow p-6">
      <h2 className="text-2xl font-bold mb-4">📋 Action Plan</h2>

      <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-4">
        <h3 className="font-semibold mb-2">Critical Manual Testing</h3>
        <p className="text-sm mb-3">
          {actionPlan.phases[0].tasks.length} criteria require verification
        </p>
        <button
          onClick={handleStartTesting}
          className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
        >
          📋 Start Manual Testing
        </button>
      </div>

      <TaskList tasks={actionPlan.phases[0].tasks} />
    </section>
  );
};
```

### Task List Component

`src/components/reports/TaskList.tsx`:
```typescript
export const TaskList = ({ tasks }) => (
  <div className="space-y-2">
    {tasks.map(task => (
      <div key={task.criterionId} className="flex items-center gap-3 p-3 bg-gray-50 rounded">
        <StatusIcon status={task.status} />
        <div className="flex-1">
          <span className="font-medium">{task.criterionId}</span>
          <span className="text-gray-600 ml-2">{task.name}</span>
        </div>
        <span className="text-sm text-gray-500">{task.estimatedTime}</span>
      </div>
    ))}
  </div>
);
```

---

## Phase 2: Enhanced Verification Queue (Weeks 5-8)

### Enhanced Queue View

`src/components/verification/EnhancedVerificationQueue.tsx`:
```typescript
export const EnhancedVerificationQueue = ({ jobId }) => {
  const { data } = useQuery(['queue', jobId],
    () => verificationApi.getEnhancedQueue(jobId));

  return (
    <div>
      <BackToReportButton jobId={jobId} />
      <ProgressBar jobId={jobId} />

      <div className="space-y-4">
        {data?.items.map(item => (
          <QueueItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
};
```

### Queue Item with AI Context

`src/components/verification/QueueItem.tsx`:
```typescript
export const QueueItem = ({ item }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center gap-3">
        <PriorityBadge priority={item.aiContext.priority} />
        <div className="flex-1">
          <h3 className="font-semibold">{item.criterionId} {item.wcagCriterion}</h3>
          <p className="text-sm text-gray-600">{item.aiContext.priorityReason}</p>
        </div>
        <span className="text-sm text-gray-500">{item.aiContext.estimatedTime}</span>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          <DetectedIssues issues={item.aiContext.detectedIssues} />
          <Recommendations recommendations={item.aiContext.recommendations} />
          <TestingGuidePreview criterionId={item.criterionId} />
        </div>
      )}

      <button onClick={() => setExpanded(!expanded)} className="text-blue-600 mt-2">
        {expanded ? 'Show Less' : 'Show Details'}
      </button>
    </div>
  );
};
```

### Testing Guide Modal

`src/components/verification/TestingGuideModal.tsx`:
```typescript
export const TestingGuideModal = ({ criterionId, onClose }) => {
  const { data } = useQuery(['guide', criterionId],
    () => verificationApi.getTestingGuide(criterionId));

  return (
    <Modal onClose={onClose}>
      <h2 className="text-xl font-bold mb-4">
        Testing Guide: {criterionId}
      </h2>

      <div className="space-y-4">
        {data?.steps.map(step => (
          <div key={step.order} className="border-l-4 border-blue-500 pl-4">
            <h3 className="font-semibold">Step {step.order}</h3>
            <p>{step.instruction}</p>
            <p className="text-sm text-gray-600">{step.helpText}</p>
            <span className="text-xs text-gray-500">~{step.estimatedTime}</span>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <h3 className="font-semibold mb-2">Recommended Tools:</h3>
        <ToolsList tools={data?.tools} />
      </div>

      <div className="mt-6">
        <h3 className="font-semibold mb-2">Pass Criteria:</h3>
        <PassCriteria criteria={data?.passCriteria} />
      </div>
    </Modal>
  );
};
```

---

## Phase 3: Status Updates (Weeks 9-10)

### Back to Report Button

`src/components/verification/BackToReportButton.tsx`:
```typescript
export const BackToReportButton = ({ jobId }) => {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(`/acr/reports/${jobId}/analysis?verified=true`)}
      className="flex items-center gap-2 text-blue-600 mb-4"
    >
      <ArrowLeftIcon className="w-4 h-4" />
      Back to AI Analysis Report
    </button>
  );
};
```

### Status Updates in Action Plan

Update `ActionPlanSection` to show verification status:

```typescript
const { data: progress } = useVerificationProgress(jobId);

{progress && (
  <div className="mb-4">
    <ProgressSummary progress={progress} />
  </div>
)}
```

---

## API Integration

`src/api/verification.api.ts`:
```typescript
export const verificationApi = {
  async initFromReport(jobId: string, data: any) {
    const res = await fetch(`/api/v1/verification/${jobId}/init-from-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async getEnhancedQueue(jobId: string) {
    const res = await fetch(`/api/v1/verification/${jobId}/queue/enhanced`);
    return res.json();
  },

  async getProgress(jobId: string) {
    const res = await fetch(`/api/v1/verification/${jobId}/progress`);
    return res.json();
  }
};
```

---

## Testing & Commits

```bash
npm test
git commit -m "feat(fe-t2): Add Action Plan and enhanced verification"
git push origin feature/ai-report-frontend-2
```

---

## Integration Points with FE-T1

- FE-T1 creates the report page
- You add `<ActionPlanSection>` to it
- FE-T1 creates `<ProgressBar>`
- You use it in verification queue
- Both use same API types

**Status:** Ready to implement
