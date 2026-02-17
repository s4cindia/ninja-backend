# Feedback Enhancement Design

**Version:** 1.0
**Date:** January 6, 2026
**Status:** Proposed

---

## Overview

Transform the feedback system from simple submissions into a collaborative issue tracking system with:
1. **File attachments** - Screenshots, documents for bug reports
2. **@mentions** - Tag users for collaboration
3. **Threaded conversations** - Discussion with resolution workflow

---

## Database Schema Design

```
┌─────────────────────────────────────────────────────────────────┐
│                         Feedback                                 │
│─────────────────────────────────────────────────────────────────│
│ + resolvedById (FK → User)                                      │
│ + resolvedAt (DateTime)                                         │
│ + attachments[] → FeedbackAttachment                            │
│ + comments[] → FeedbackComment                                  │
│ + mentions[] → FeedbackMention                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│FeedbackAttachment │ │ FeedbackComment   │ │ FeedbackMention   │
│───────────────────│ │───────────────────│ │───────────────────│
│ id                │ │ id                │ │ id                │
│ feedbackId (FK)   │ │ feedbackId (FK)   │ │ feedbackId (FK?)  │
│ filename (S3 key) │ │ userId (FK)       │ │ commentId (FK?)   │
│ originalName      │ │ content           │ │ userId (FK)       │
│ mimeType          │ │ mentions[]        │ │ notified          │
│ size              │ │ createdAt         │ │ createdAt         │
│ uploadedById (FK) │ │ updatedAt         │ └───────────────────┘
│ createdAt         │ └───────────────────┘
└───────────────────┘
```

---

## API Design

### Attachments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/feedback/:id/attachments` | Upload file(s) |
| GET | `/feedback/:id/attachments` | List attachments |
| GET | `/feedback/attachments/:id/download` | Download file |
| DELETE | `/feedback/attachments/:id` | Delete attachment |

### Comments (Threads)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/feedback/:id/comments` | List comments |
| POST | `/feedback/:id/comments` | Add comment |
| PUT | `/feedback/comments/:id` | Edit comment |
| DELETE | `/feedback/comments/:id` | Delete comment |

### Resolution

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/feedback/:id/resolve` | Mark as resolved |
| POST | `/feedback/:id/reopen` | Reopen feedback |

### User Search (for @mentions)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/search?q=term` | Search users for autocomplete |

---

## Frontend Components

```
FeedbackDetail (enhanced)
├── FeedbackHeader
│   ├── Status badge
│   ├── Resolution info (who/when)
│   └── Resolve/Reopen button
├── FeedbackContent
│   └── Original message with @mentions highlighted
├── AttachmentsList
│   ├── AttachmentItem (thumbnail/icon, name, size, download)
│   └── AttachmentUploader (drag-drop zone)
├── CommentThread
│   ├── CommentItem
│   │   ├── User avatar/name
│   │   ├── Content with @mentions
│   │   ├── Timestamp
│   │   └── Edit/Delete actions
│   └── CommentInput
│       ├── MentionTextarea (with @ autocomplete)
│       └── Submit button
└── FeedbackActions
    └── Status change dropdown
```

---

## Implementation Phases

### Phase 1: Conversation Threads + Resolution (Priority 1)

**Backend:**
- Add `FeedbackComment` model to Prisma schema
- Add `resolvedById`, `resolvedAt` to Feedback model
- Create comment CRUD endpoints
- Create resolve/reopen endpoints
- Run migration

**Frontend:**
- Create `CommentThread` component
- Create `CommentItem` component
- Create `CommentInput` component
- Add resolve/reopen buttons to `FeedbackDetail`
- Show resolution info in header

### Phase 2: File Attachments (Priority 2)

**Backend:**
- Add `FeedbackAttachment` model to Prisma schema
- Create S3 upload/download logic (reuse existing file service patterns)
- Create attachment CRUD endpoints
- Run migration

**Frontend:**
- Create `AttachmentsList` component
- Create `AttachmentUploader` component (drag-drop)
- Add attachment display with thumbnails for images
- Add download buttons

### Phase 3: @Mentions (Priority 3)

**Backend:**
- Add `FeedbackMention` model to Prisma schema
- Create user search endpoint
- Parse @mentions from content on save
- Store mentions in database
- (Future: Send notifications)

**Frontend:**
- Create `MentionTextarea` component with autocomplete
- Highlight @mentions in displayed content
- User search dropdown on @ keystroke

---

## Prisma Schema Changes

```prisma
// Add to existing Feedback model
model Feedback {
  // ... existing fields ...
  resolvedById  String?
  resolvedBy    User?              @relation("FeedbackResolver", fields: [resolvedById], references: [id], onDelete: SetNull)
  resolvedAt    DateTime?

  attachments   FeedbackAttachment[]
  comments      FeedbackComment[]
  mentions      FeedbackMention[]
}

model FeedbackAttachment {
  id           String   @id @default(uuid())
  feedbackId   String
  feedback     Feedback @relation(fields: [feedbackId], references: [id], onDelete: Cascade)
  filename     String   // S3 key
  originalName String
  mimeType     String
  size         Int
  uploadedById String?
  uploadedBy   User?    @relation("AttachmentUploader", fields: [uploadedById], references: [id], onDelete: SetNull)
  createdAt    DateTime @default(now())
}

model FeedbackComment {
  id         String            @id @default(uuid())
  feedbackId String
  feedback   Feedback          @relation(fields: [feedbackId], references: [id], onDelete: Cascade)
  userId     String
  user       User              @relation("CommentAuthor", fields: [userId], references: [id], onDelete: Cascade)
  content    String
  mentions   FeedbackMention[]
  createdAt  DateTime          @default(now())
  updatedAt  DateTime          @updatedAt
}

model FeedbackMention {
  id         String           @id @default(uuid())
  feedbackId String?
  feedback   Feedback?        @relation(fields: [feedbackId], references: [id], onDelete: Cascade)
  commentId  String?
  comment    FeedbackComment? @relation(fields: [commentId], references: [id], onDelete: Cascade)
  userId     String
  user       User             @relation("MentionedUser", fields: [userId], references: [id], onDelete: Cascade)
  notified   Boolean          @default(false)
  createdAt  DateTime         @default(now())
}

// Add to User model
model User {
  // ... existing fields ...
  resolvedFeedbacks    Feedback[]           @relation("FeedbackResolver")
  uploadedAttachments  FeedbackAttachment[] @relation("AttachmentUploader")
  feedbackComments     FeedbackComment[]    @relation("CommentAuthor")
  feedbackMentions     FeedbackMention[]    @relation("MentionedUser")
}
```

---

## Priority Matrix

| Priority | Feature | Effort | Value | Dependencies |
|----------|---------|--------|-------|--------------|
| 1 | Conversation Threads + Resolution | Medium | High | None |
| 2 | File Attachments | Medium | High | S3 (existing) |
| 3 | @Mentions | High | Medium | User search |

---

## Future Considerations

- **Email notifications** for @mentions and status changes
- **Activity log** tracking all changes to feedback
- **Assignee field** to assign feedback to specific users
- **Labels/Tags** for categorization beyond type
- **Due dates** for resolution SLAs
- **Integration** with external issue trackers (Jira, GitHub Issues)

---

## Related Documentation

- [CLAUDE.md](./CLAUDE.md) - Project context
- [EPUB_AUDIT_REMEDIATION_USER_GUIDE.md](./EPUB_AUDIT_REMEDIATION_USER_GUIDE.md) - User guide
