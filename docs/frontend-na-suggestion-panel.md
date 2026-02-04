# Frontend Implementation: N/A Suggestion Panel with Quick Accept

## Overview
The backend now provides AI-suggested "Not Applicable" (N/A) status recommendations for WCAG criteria based on EPUB content analysis. The frontend needs to display these suggestions and allow users to quickly accept high-confidence suggestions.

---

## API Endpoint

**GET** `/api/v1/confidence/job/{jobId}/issues`

Returns criteria with optional `naSuggestion` field when the AI detects a criterion may not apply to the content.

---

## Response Structure

```typescript
interface ConfidenceResponse {
  success: boolean;
  data: {
    jobId: string;
    criteria: CriterionWithSuggestion[];
    // ... other fields
  }
}

interface CriterionWithSuggestion {
  criterionId: string;           // e.g., "1.2.1"
  criterionName: string;         // e.g., "Audio-only and Video-only (Prerecorded)"
  wcagLevel: "A" | "AA" | "AAA";
  status: string;                // Current status: "pass", "fail", "needs_review"
  confidenceScore: number;       // 0-100
  
  // N/A SUGGESTION - Only present when AI suggests Not Applicable
  naSuggestion?: NaSuggestion;
}

interface NaSuggestion {
  suggestedStatus: "not_applicable";
  confidence: number;            // 0-100 (show Quick Accept if >= 80)
  rationale: string;             // Human-readable explanation
  detectionChecks: DetectionCheck[];
  edgeCases: string[];           // Potential edge cases to consider
}

interface DetectionCheck {
  check: string;                 // e.g., "Audio file presence"
  result: "pass" | "fail";       // "pass" = no content found (supports N/A)
  details: string;               // e.g., "No .mp3, .wav files found"
}
```

---

## Example API Response

```json
{
  "success": true,
  "data": {
    "jobId": "ac9be27c-3a52-42f8-8ab2-d89ba8dbff15",
    "criteria": [
      {
        "criterionId": "1.2.1",
        "criterionName": "Audio-only and Video-only (Prerecorded)",
        "wcagLevel": "A",
        "status": "pass",
        "confidenceScore": 95,
        "naSuggestion": {
          "suggestedStatus": "not_applicable",
          "confidence": 95,
          "rationale": "No audio-only or video-only prerecorded content was detected in this EPUB. The publication contains only text and static images.",
          "detectionChecks": [
            {
              "check": "Audio file presence",
              "result": "pass",
              "details": "No .mp3, .wav, .ogg, or .aac files found in manifest"
            },
            {
              "check": "Video file presence",
              "result": "pass",
              "details": "No .mp4, .webm, .mov, or .avi files found in manifest"
            },
            {
              "check": "Embedded media elements",
              "result": "pass",
              "details": "No <audio> or <video> HTML elements detected"
            },
            {
              "check": "External media references",
              "result": "pass",
              "details": "No external media references found"
            }
          ],
          "edgeCases": []
        }
      },
      {
        "criterionId": "1.1.1",
        "criterionName": "Non-text Content",
        "wcagLevel": "A",
        "status": "pass",
        "confidenceScore": 90
        // No naSuggestion - this criterion applies to all content with images
      }
    ]
  }
}
```

---

## UI Requirements

### 1. N/A Suggestion Panel (in Criterion Detail View)

When `criterion.naSuggestion` exists, display a suggestion panel:

```
┌─────────────────────────────────────────────────────────────────┐
│  💡 AI Suggestion: Not Applicable                               │
│                                                                 │
│  Confidence: ████████████████░░░░ 95%                          │
│                                                                 │
│  Rationale:                                                     │
│  No audio-only or video-only prerecorded content was detected  │
│  in this EPUB. The publication contains only text and static   │
│  images.                                                        │
│                                                                 │
│  Detection Checks:                                              │
│  ✓ Audio file presence - No .mp3, .wav files found             │
│  ✓ Video file presence - No .mp4, .webm files found            │
│  ✓ Embedded media elements - No <audio>/<video> tags           │
│  ✓ External media references - None found                      │
│                                                                 │
│  ┌──────────────────┐  ┌─────────────────────┐                 │
│  │  Quick Accept    │  │  Review Manually    │                 │
│  └──────────────────┘  └─────────────────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Quick Accept Button Logic

- **Show Quick Accept button** when: `naSuggestion.confidence >= 80`
- **Disable Quick Accept** when: `naSuggestion.confidence < 80` (show "Review Required" instead)
- **Button action**: Call verification submit endpoint

### 3. Verification Submit (Quick Accept Action)

**POST** `/api/v1/verification/submit`

```typescript
// Request
{
  "criterionId": "1.2.1",
  "jobId": "ac9be27c-3a52-42f8-8ab2-d89ba8dbff15",
  "status": "not_applicable",
  "method": "quick_accept",  // Use "quick_accept" for high-confidence accepts
  "notes": "AI-suggested Not Applicable (95% confidence): No audio content detected"
}

// Response (201 Created)
{
  "success": true,
  "data": {
    "criterionId": "1.2.1",
    "jobId": "ac9be27c-3a52-42f8-8ab2-d89ba8dbff15",
    "status": "not_applicable",
    "verifiedAt": "2026-02-04T19:30:00.000Z",
    "verifiedBy": "user@example.com",
    "method": "quick_accept",
    "notes": "AI-suggested Not Applicable (95% confidence): No audio content detected"
  }
}
```

### 4. Method Values

| Method | When to Use |
|--------|-------------|
| `quick_accept` | User clicked Quick Accept (confidence >= 80%) |
| `ai_suggested` | User accepted AI suggestion after review |
| `manual_review` | User manually set status after reviewing |
| `automated` | System automatically verified |

---

## Visual Design Guidelines

### Confidence Indicator Colors

| Confidence Range | Color | Action |
|-----------------|-------|--------|
| 80-100% | Green | Show Quick Accept button |
| 60-79% | Yellow/Orange | Show "Review Suggested" button |
| 0-59% | Red | Show "Manual Review Required" |

### Detection Check Icons

- ✓ (green checkmark): `result: "pass"` - Supports N/A suggestion
- ✗ (red X): `result: "fail"` - Content detected, may not be N/A

### Panel Styling

- Use a light blue/info background color for suggestion panels
- Add a subtle border to distinguish from regular content
- Include an AI indicator icon (lightbulb, robot, or sparkle)

---

## React Component Example

```tsx
interface NaSuggestionPanelProps {
  criterion: CriterionWithSuggestion;
  jobId: string;
  onAccept: () => void;
  onReject: () => void;
}

const NaSuggestionPanel: React.FC<NaSuggestionPanelProps> = ({
  criterion,
  jobId,
  onAccept,
  onReject
}) => {
  const { naSuggestion } = criterion;
  
  if (!naSuggestion) return null;
  
  const isHighConfidence = naSuggestion.confidence >= 80;
  
  const handleQuickAccept = async () => {
    await fetch('/api/v1/verification/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        criterionId: criterion.criterionId,
        jobId,
        status: 'not_applicable',
        method: 'quick_accept',
        notes: `AI-suggested Not Applicable (${naSuggestion.confidence}% confidence): ${naSuggestion.rationale.substring(0, 100)}`
      })
    });
    onAccept();
  };
  
  return (
    <div className="na-suggestion-panel">
      <div className="panel-header">
        <span className="ai-icon">💡</span>
        <h4>AI Suggestion: Not Applicable</h4>
      </div>
      
      <div className="confidence-bar">
        <label>Confidence:</label>
        <div className="bar">
          <div 
            className="fill" 
            style={{ width: `${naSuggestion.confidence}%` }}
          />
        </div>
        <span>{naSuggestion.confidence}%</span>
      </div>
      
      <div className="rationale">
        <h5>Rationale:</h5>
        <p>{naSuggestion.rationale}</p>
      </div>
      
      <div className="detection-checks">
        <h5>Detection Checks:</h5>
        <ul>
          {naSuggestion.detectionChecks.map((check, idx) => (
            <li key={idx} className={check.result}>
              <span className="icon">
                {check.result === 'pass' ? '✓' : '✗'}
              </span>
              <span className="check-name">{check.check}</span>
              <span className="details">{check.details}</span>
            </li>
          ))}
        </ul>
      </div>
      
      {naSuggestion.edgeCases.length > 0 && (
        <div className="edge-cases">
          <h5>⚠️ Edge Cases to Consider:</h5>
          <ul>
            {naSuggestion.edgeCases.map((ec, idx) => (
              <li key={idx}>{ec}</li>
            ))}
          </ul>
        </div>
      )}
      
      <div className="actions">
        {isHighConfidence ? (
          <button 
            className="btn-primary"
            onClick={handleQuickAccept}
          >
            Quick Accept
          </button>
        ) : (
          <button 
            className="btn-secondary"
            onClick={handleQuickAccept}
          >
            Accept After Review
          </button>
        )}
        <button 
          className="btn-outline"
          onClick={onReject}
        >
          Review Manually
        </button>
      </div>
    </div>
  );
};
```

---

## Criteria That May Have N/A Suggestions

The content detection analyzes EPUBs and suggests N/A for these criterion groups:

| Criterion Group | Suggested N/A When |
|----------------|-------------------|
| 1.2.x (Audio/Video) | No audio or video files/elements detected |
| 1.4.2 (Audio Control) | No auto-playing audio detected |
| 2.1.4 (Character Key Shortcuts) | No JavaScript keyboard handlers detected |
| 2.2.x (Timing) | No time-limited content or auto-updating detected |
| 2.3.1 (Flashing) | No animated content detected |
| 3.2.x (Predictable) | No forms or interactive elements detected |
| 3.3.x (Input Assistance) | No form inputs detected |

---

## Testing Checklist

- [ ] N/A suggestion panel appears when `naSuggestion` is present
- [ ] Confidence bar displays correctly (0-100%)
- [ ] Quick Accept button shows for confidence >= 80%
- [ ] Quick Accept button hidden/disabled for confidence < 80%
- [ ] All detection checks render with correct icons
- [ ] Edge cases section shows when applicable
- [ ] POST to `/api/v1/verification/submit` succeeds on Quick Accept
- [ ] UI updates after successful submission
- [ ] Error handling for failed submissions
