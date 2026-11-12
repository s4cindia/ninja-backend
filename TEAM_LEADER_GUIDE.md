# Ninja Platform — Team Leader Guide

**This is the Team Leader's reference for leading a team on the Ninja platform: assigning titles to your Executives, tracking your team's work, spot-checking quality, and reviewing team activity.** It assumes you're already familiar with the hands-on audit/remediation workflow itself — for that, see the **Operator Guide**. This guide is specifically about the oversight/management side of the Team Leader role, which is a separate concept from your platform role (see Part 1 below).

---

## Table of Contents

- [Part 1 — Platform Role vs. Team Role](#part-1--platform-role-vs-team-role)
- [Part 2 — Assigning a Title to an Executive](#part-2--assigning-a-title-to-an-executive)
- [Part 3 — My Team](#part-3--my-team)
- [Part 4 — The QC Shipment Gate (Team Review)](#part-4--the-qc-shipment-gate-team-review)
- [Part 5 — Team Activity Reporting](#part-5--team-activity-reporting)
- [Part 6 — Known Gaps / Open Items](#part-6--known-gaps--open-items)

---

## Part 1 — Platform Role vs. Team Role

Every account carries **two independent roles** that answer two different questions, not one combined permission level:

- **Platform role** (`Admin` / `Operator` / `User` / `Viewer`) — what you can do platform-wide. An Admin can access any job in their own tenant and reaches the Admin section (Operational Reports, tenant settings); every other platform role is scoped to their own work.
- **Team role** (`Team Leader` / `Executive` / team-level `Viewer`) — your standing within a production **Team** (a "cell": one Team Leader plus a handful of Executives), completely independent of platform role. An **Executive** owns and works their own jobs end-to-end — see the Operator Guide for that whole workflow. A **Team Leader** (you, if you're reading this) additionally gets read-only review access to your team's jobs and the two new capabilities this guide covers: assigning titles directly to an Executive, and spot-checking their work. A team-level **Viewer** gets the same read-only review access as a Team Leader, without the ability to assign work.

Both roles are shown together next to your name in the top-right header. A Team Leader can lead more than one team ("cell") — everything below handles that case; your Executives and jobs from every team you lead are combined, each clearly labeled with which team it belongs to.

**Team composition itself (who's on your team) is Admin-managed**, not something you configure yourself from this guide's pages — if you need someone added to or removed from your team, that goes through your Admin.

---

## Part 2 — Assigning a Title to an Executive

Instead of telling an Executive out of band which file to upload themselves, you can upload a PDF yourself and assign it directly to them in one step.

**How to do it:** on the PDF upload flow (the same **PDF Accessibility** entry point the Operator Guide's Part 4, Step 1 describes), you'll see an **"Assign to"** dropdown that only appears for you, because you're a Team Leader — Executives and non-Team-Leaders never see it. It lists every Executive across every team you lead, labeled with their name and team (so if you lead more than one cell, it's unambiguous which team's Executive you're picking). Leave it unselected to upload for yourself as normal — nothing changes from today's behavior.

**What happens when you pick someone:** the resulting job is owned by that Executive from the moment it's created, not by you — the initial audit kicks off exactly as it always does, and the Executive gets notified immediately (both an in-app notification and an email) that a new title has been assigned to them. Clicking the notification takes them straight to the Audit Results page, whether the audit is still running or already finished — there's no separate "pending assignment" state to manage, and no accept step on their end. From that point on, it's their job like any other: it shows up in their own Jobs list, and in your own My Team view (Part 3).

**What this does *not* do (yet):**
- There's no built-in way to reassign or unassign a title after the fact from this flow. If you genuinely need to move a title to someone else, that's an Admin action today (ask your Admin) — this is deliberately not a self-service Team Leader action yet, since it's expected to be a rare correction, not a routine one.
- There's no limit on how many open titles you can assign to one Executive — it's your own judgment call, the same as it always was when this was a verbal hand-off. Nothing here tracks or warns about workload balance yet.
- There's no bulk/batch version of this — you can only assign one title at a time, to one Executive, via a single upload. Uploading a batch of files and splitting them across several Executives isn't supported.
- An "auto-assign" setting (so uploads route to the right Executive automatically, without you picking one each time) is a possible future addition, not something that exists today.

---

## Part 3 — My Team

**Where it is:** sidebar → **My Team**. Only visible to you because you hold a Team Leader (or team-level Viewer) role on at least one team.

**What it shows:** a flat, paginated table of every job owned by any of your teammates (across every team you lead), filterable by status (Queued/Processing/Completed/Failed/Cancelled). Columns: File, Type, Status (with a **Blocked** badge if the job's most recent Team Review verdict is Needs Correction — see Part 4), Owner, Created, and a View action.

Below the job table, a **Team Activity** section (Part 5) rolls up your team's Review Throughput and Job Ownership for the last 30 days.

**What it does not show:** a roster of your Executives independent of their jobs (an Executive with zero jobs in the current period simply doesn't appear here at all — use the "Assign to" dropdown in Part 2 if you need to see who's on your team right now), or any workload/capacity view beyond simple job counts.

---

## Part 4 — The QC Shipment Gate (Team Review)

As a Team Leader, you can leave a spot-check verdict (**OK** or **Needs Correction**, plus notes) on a teammate's job — via the Team Review panel on that job's own Audit Results page, or from My Team.

This is a **real gate**, not just an audit trail: the job's most recent verdict controls whether it can ship. A **Needs Correction** verdict blocks **Download AI-Fixed PDF** (and the equivalent EPUB export) with a clear "blocked" message, until a follow-up review records **OK**. A job nobody has reviewed yet still ships normally — review isn't mandatory, only an active rejection blocks.

**What happens on each side:**
- The owning Executive is notified automatically the moment you flag something Needs Correction. They see your note, and once they've addressed it, a **Request re-review** action notifies you back.
- A job nobody's reviewed at all is simply unblocked — there's no pending/waiting state to track here beyond what the job's own status already shows.

Review isn't limited to titles you assigned yourself (Part 2) — it applies to anything owned by anyone on a team you lead, assigned by you or uploaded by them directly, exactly the same way.

---

## Part 5 — Team Activity Reporting

**Where it is:** the Team Activity section on My Team (Part 3), or the fuller self-service report at the same data (sidebar → My Team → the activity section below the job table).

**Team Review Throughput** — per-reviewer OK/Needs Correction counts, with a progress bar. This is not a performance scorecard for the people being reviewed — a low "OK" count for a reviewer could just as easily mean they're genuinely catching real problems.

**Job Ownership** — a per-teammate rollup (Total/Completed/Failed/In Progress job counts, completion rate), with an expandable list of that person's individual jobs (title, type, status, time) for the period. This is where you can get a sense of how work is distributed across your team, even though there's no automated balancing yet (Part 2's known gaps).

The tenant-wide, all-teams version of this same report (for Admins) lives separately under Admin → Operational Reports → Team Activity — what you see here is scoped to just the team(s) you lead.

---

## Part 6 — Known Gaps / Open Items

- **No self-service reassignment.** Moving an already-assigned title to a different Executive requires an Admin today (Part 2).
- **No capacity guardrail.** Assigning titles to one Executive has no limit or warning based on their current workload (Part 2).
- **No batch assignment.** One upload assigns to exactly one Executive; there's no way to upload several files and split them across your team in one action (Part 2).
- **No standalone Executive roster view.** My Team (Part 3) only ever shows teammates who have at least one job in the current period — there's no plain "who's on my team" list independent of jobs, outside of the "Assign to" dropdown itself.
- **Auto-assignment** (uploads routing to an Executive automatically based on some strategy, rather than you picking one each time) is a possible future addition, not implemented.
