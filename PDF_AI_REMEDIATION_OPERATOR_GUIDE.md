# PDF AI Remediation — Operator Guide

**Version 2 — this is the operator's complete reference for auditing and remediating a PDF document on the Ninja platform, from upload through final compliance sign-off.** It assumes no prior familiarity with the platform. If you're new, read Part 1 and Part 4 first — those two sections are the ones you'll actually follow on your first job. Everything else is reference material to come back to as you need it.

---

## Table of Contents

- [Part 1 — How This Platform Is Organized](#part-1--how-this-platform-is-organized)
- [Part 2 — Core Concepts &amp; Glossary](#part-2--core-concepts--glossary)
- [Part 3 — The Jobs Page and the Files Page](#part-3--the-jobs-page-and-the-files-page)
- [Part 4 — The Complete Operator Workflow (Step by Step)](#part-4--the-complete-operator-workflow-step-by-step)
- [Part 5 — The PDF Audit Results Page — Full Reference](#part-5--the-pdf-audit-results-page--full-reference)
- [Part 6 — The Guided Remediation Checklist](#part-6--the-guided-remediation-checklist)
- [Part 7 — The PDF Remediation Plan Page](#part-7--the-pdf-remediation-plan-page)
- [Part 8 — The ACR Workflow](#part-8--the-acr-workflow)
- [Part 9 — Operational Reports (Admin)](#part-9--operational-reports-admin)
- [Part 10 — Settings &amp; Tenant Configuration](#part-10--settings--tenant-configuration)
- [Part 11 — Reference: Known-Fixed PAC Issue Categories](#part-11--reference-known-fixed-pac-issue-categories)
- [Part 12 — Known Gaps / Open Items](#part-12--known-gaps--open-items)
- [Part 13 — Feedback & Defect Reporting](#part-13--feedback--defect-reporting)

---

## Part 1 — How This Platform Is Organized

The left sidebar is your map of the whole platform:

| Sidebar item | What it's for |
|---|---|
| **Dashboard** | Account-level landing page. |
| **Products** | The list of products your account has access to. |
| **Jobs** | Every processing run against every document, across every product — your cross-product command center (Part 3). |
| **Files** | The document library itself — raw uploads, independent of any one job (Part 3). |
| **My Team** | Team membership, review assignments, and (for Team Leaders) your own team's activity view. |
| **Accessibility** section | **EPUB Accessibility**, **PDF Accessibility** (this guide's main subject), **ACR Workflow**, **Alt-Text Generator**. |
| **Editorial** section | Editorial Services, Style Rules — a separate product line, not covered by this guide. |
| **Tools** section | **Remediation**, **Batch Processing**, **Feedback** (Part 13) — covered where relevant below. |
| **Admin** section *(admin role only)* | **Operational Reports** (Part 9) and tenant-wide settings (Part 10). |

**Where you'll spend almost all your time as an operator:** upload through **PDF Accessibility**, then do essentially everything on the **Audit Results page** it takes you to. Jobs and Files are where you go to find a document again later, or to manage the raw file library. Everything else in the sidebar is either admin-only or a separate product.

---

## Part 2 — Core Concepts &amp; Glossary

Read this once before your first job — these terms appear everywhere in the rest of the guide.

**Matterhorn Protocol** — a formal, checkpoint-by-checkpoint interpretation of the PDF/UA standard (31 checkpoints, 137 conditions in Ninja's own implementation). It's the authoritative rulebook both Ninja's own validators and the real PAC Desktop tool check a document against.

**PDF/UA** — "PDF Universal Accessibility," the ISO standard (ISO 14289-1) for accessible PDFs. "PDF/UA compliant" means a document passes every machine-checkable Matterhorn condition.

**WCAG** — Web Content Accessibility Guidelines. Some of Ninja's own findings are WCAG-style (broader than strict Matterhorn), shown alongside Matterhorn findings in the Issues panel.

**PAC (PDF Accessibility Checker)** — the real, independent third-party desktop tool (made by axes4) that checks PDF/UA compliance. Ninja has its own **simulated** version of this same check (the "Ninja Report" tab, Part 5.9) that's free and instant, plus the ability to run the **real** axes4 engine (either live from inside Ninja, if your tenant has paid access configured, or by running the actual PAC Desktop application yourself and uploading its report — Part 4, Step 11).

**ACR / VPAT** — Accessibility Conformance Report, the formal document you hand to a customer or compliance team describing how well the document conforms to a named standard. Generated via the ACR Workflow (Part 8).

**Accessibility Score** — the single number shown top-right on the Audit Results page, a severity- and page-density-weighted score (not a flat count) summarizing the document's current state.

**Auto-tagged badge** — shown next to the file name when the document arrived with no real structure tags at all and Ninja's own Seam-C (YOLO-model-based) pipeline built its structure tree from scratch, rather than the document already having real tags (e.g. from InDesign export).

**Apply modes** — every AI suggestion is tagged with one of:
- **apply-to-pdf** — eligible to be written into the PDF automatically (after approval, or immediately if auto-resolved).
- **guidance-only** — the AI drafted a suggestion, but it will never auto-apply; a human must act (usually outside Ninja, e.g. in Acrobat Pro) and then verify.
- **auto-resolve** — a small category of deterministic, confidence-1.0 fixes (e.g. setting a single flag) that apply immediately with no human approval step at all.
- **disabled** — this category isn't attempted at all for this tenant/run.

**Confidence tiers** — every AI-drafted suggestion carries a confidence percentage: **High (≥90%)**, **Medium (70–89%)**, **Low (&lt;70%)**. A low-confidence suggestion still shows up (visibly badged) rather than disappearing — you get to judge it yourself rather than the system silently hiding its own uncertainty.

**Auto Mode vs. manual** — "Auto Mode" (Start Auto Remediation) runs its own internal loop — analyze → auto-approve → apply → re-audit — repeatedly, with no operator click in between rounds. Everything else in this guide (Re-run AI Analysis, Apply Fixes, Re-run Audit) is a **manual**, single-shot action you trigger yourself.

**The 5-phase stepper** — a horizontal progress indicator near the top of the Audit Results page: **Audit → AI Analysis → Remediation → Verification → Compliance**. It's a coarse, at-a-glance summary; the Guided Remediation Checklist (Part 6) is the detailed, authoritative version of the same journey.

**Remediation cycle lock** — only one remediation action (a manual Apply, a bulk Apply, an Auto Mode round, a manual-fix re-audit upload) can run on a given job at a time. If you see a control greyed out with a message naming who/what currently holds the lock, that's why — wait for it to clear, don't fight it.

**Platform role vs. team role** — every account carries **two independent roles** that answer two different questions, not one combined permission level:
- **Platform role** (`ADMIN` / `OPERATOR` / `USER` / `VIEWER`) — what you can do platform-wide. An **Admin** can access any job in their own tenant (not just their own) and reaches the Admin section (Operational Reports — Part 9, tenant settings — Part 10); every other platform role is scoped to their own work. Note: "operator" in this guide's title is a description of the job, not necessarily the exact `OPERATOR` platform role — check with your own admin which platform role your account actually has if you're unsure.
- **Team role** (`TEAM_LEADER` / `EXECUTIVE` / team-level `VIEWER`) — your standing within a production **Team** (a "cell": one Team Leader plus a handful of Executives), completely independent of platform role. An **Executive** owns and works their own jobs end-to-end. A **Team Leader** additionally gets read-only review access to their team's jobs — this is what powers the QC Shipment Gate immediately below — a spot-check capability, not a grant to edit or act on someone else's work. A team-level **Viewer** gets that same read-only review access without the Team Leader's other responsibilities. Not everyone has a team membership at all — it's optional, unlike platform role which every account has.

Both roles are shown together next to your name in the top-right header — if you're ever unsure which permissions apply to you, look there first.

**QC Shipment Gate (Team Review)** — a Team Leader can leave a spot-check verdict (**OK** or **Needs Correction**, plus notes) on a teammate's job via the Team Review panel on that job's Audit Results page, or from **My Team**. The job's **most recent** verdict actually gates shipment: a **Needs Correction** blocks **Download AI-Fixed PDF** (and the equivalent EPUB export) with a clear "blocked" message, until a follow-up review records **OK**. A job nobody has reviewed yet still ships normally — review isn't mandatory, only an active rejection blocks. The owning Executive is notified automatically when flagged, sees the reviewer's note plus a **Request re-review** action once they've addressed it, and the Team Leader is notified back when that happens. This is a real gate now, not just an audit trail — see Part 4 (Step 10) and Part 5.2's toolbar reference for where the block itself shows up, and Part 9 (Team Activity) for the reviewer's-eye view.

---

## Part 3 — The Jobs Page and the Files Page

### Jobs Page

**What it is:** A "job" is one processing run against one document — an audit, a citation scan, an editorial validation pass, etc. The Jobs page is a unified, cross-product list of every job on the account.

**Layout:** Five stat cards up top (**Total / Queued / Processing / Completed / Failed**), then filter tabs by job type (**All Jobs / EPUB Audit / Citation Management / PDF Audit / Validator**, each with a live count), then a status dropdown (All Statuses / Queued / Processing / Completed / Failed / Cancelled) with a **Clear filters** button once any filter is active. The list auto-refreshes on its own.

**Table columns:** File, Type, Status (colored badge), Progress (bar + % while Processing, 100% once Completed), Created (relative time), Actions.

**Job statuses:**

| Status | Meaning |
|---|---|
| **Queued** | Accepted, waiting for a worker to pick it up — nothing happening yet. |
| **Processing** | A worker is actively running it right now; Progress shows a live percentage. |
| **Completed** | Finished successfully — click through to view results. |
| **Failed** | Hit an unrecoverable error — check the job's own results page (or support) for why. |
| **Cancelled** | An operator cancelled it before it finished. |

**Actions:** **View** (eye icon, every row) navigates to the right results page for that job's type — a PDF Audit job goes to the Audit Results page this whole guide is about. **Cancel** appears only while Queued/Processing. **Delete** (red trash icon) permanently deletes the job and its data, with a confirmation dialog — always available regardless of status.

There is **no bulk select/delete/audit on the Jobs page** — every action here is per-row. Pagination is 10 jobs per page.

**When to use it:** filter to **PDF Audit** to see only PDF jobs; filter to **Processing** to check what's running right now; filter to **Failed** to find jobs needing attention. Use Jobs (not Files) when you want to see what's actively running, or to cancel/clean up a specific job.

### Files Page

**What it is:** A "file" is the uploaded document itself — the source record a job gets created from. One file can have multiple jobs run against it over time. Think "my documents" (Files) vs. "what's been run against my documents" (Jobs) — related, not the same list.

**Uploading here:** click **Upload File**, then drag-and-drop or browse. This generic uploader accepts **PDF, EPUB, DOCX** up to **50MB**, and the upload starts immediately on file selection.

> **Important for PDF accessibility work:** this 50MB cap is specific to the generic Files-page uploader. For the actual PDF audit/remediation workflow this guide covers, upload through the dedicated **PDF Accessibility** entry point in the sidebar instead (Part 4, Step 1) — it supports much larger documents, and it's the path that actually takes you into the workflow described in this guide. Use the Files page for managing the document library, not for starting a PDF audit.

**Table columns:** a select-all checkbox, File, Type (PDF/EPUB/DOCX), Size, Status (**Uploaded** / **Processing** / **Processed** / **Error**, each with its own icon/color), Uploaded (date/time), Actions.

**Row actions:**
- **Run Audit** (green play icon) — ⚠️ only appears for **EPUB** files that are Uploaded or Processed. PDF and DOCX files never show this button here.
- **View** (eye icon) — only once a file is Processed.
- **Delete** (red trash icon) — always available, confirms first.
- Clicking anywhere else on the row opens the **File Details** modal: icon, full name, a 2×2 grid (Type, Size, Status, Uploaded — full timestamp), and (if ever audited) its Latest Job ID, plus repeated Run Audit / View Results / Delete buttons in the modal's own footer.

**Bulk actions:** select one or more rows (or the header checkbox for all) and a bar slides up showing "N file(s) selected," **Clear**, **Run Audit (N)** (only enabled when *every* selected file is an EPUB in Uploaded/Processed status), and **Delete (N)** (reports how many succeeded/failed).

**When to use it:** managing the document library — uploading new source files, bulk-cleaning test uploads, checking a file's exact size/type/status. For the PDF audit-and-remediate workflow itself, move to PDF Accessibility once the file exists.

---

## Part 4 — The Complete Operator Workflow (Step by Step)

This is the spine of the guide. Follow it top to bottom on a normal job; the branch points are called out explicitly.

### Step 1 — Upload

From the sidebar, go to **PDF Accessibility** and upload the document. This kicks off the **initial audit** automatically — Ninja's own structure/content/contrast/table/link/bookmark validators run against the document, followed immediately by the first **AI Analysis** pass (using your tenant's current default settings for alt-text/color-contrast/link-text — see Part 10). You land on the **Audit Results page** (Part 5) once this completes.

If the document arrives with no real structure tags at all, you'll see the **"Auto-tagged: Seam-C (YOLO)"** badge next to the file name — Ninja built the structure tree from scratch. If it already had real tags (e.g. a clean InDesign export), you'll see **"Already tagged"** instead.

### Step 2 — Decide: does the client supply their own alt text for this job?

This is a per-job decision that shapes every alt-text setting for the rest of the workflow. There are two paths:

- **No (the common case) — let AI generate alt text.** Use `apply-to-pdf` / "Generate AI alt text" wherever alt-text mode is selectable. AI drafts and auto-applies alt text for images; you review afterward in the Issues panel (every drafted suggestion is visible with its confidence tier, even the low-confidence ones — nothing is hidden).
- **Yes — the client has already supplied their own descriptions.** Use `guidance-only` / "Client supplied their own alt text" wherever alt-text mode is selectable. The AI vision call still runs and still drafts a suggestion for every image (nothing is skipped on the detection side) — it just won't auto-apply. Instead, open each alt-text suggestion's card in the Issues panel, select-all in its editable textarea, and paste/type the client's own text in its place before clicking Apply. This is a per-image manual step — there is currently no bulk-ingest mechanism for many client-supplied descriptions at once, and no in-UI override for an image the AI already classified as decorative (its card renders as read-only guidance text, not an editable box, in that case).

Keep this decision in mind for Steps 3 and 6 below — alt-text mode is set independently in two different places and neither one automatically matches the other.

### Step 3 — Start Auto Remediation

On the Audit Results page toolbar, click **Start Auto Remediation**. This opens a popover with its own settings, completely independent of anything on the toolbar's checkboxes (those only matter for Step 6):

| Setting | Recommended value | Notes |
|---|---|---|
| **Max rounds** | 10 (default) | Raise it only if you already know this document needs more; otherwise let the default run and raise it later if you hit the round-limit stop reason (Step 4). |
| **Cost limit (USD)** | Use the suggested estimate if one is shown, otherwise the $2 default | The popover pre-fills a document-size-based estimate when enough historical data exists; trust it over the flat default when it's shown. |
| **Color-contrast handling** | **Guidance only** | Recommended default for this workflow — contrast fixes directly rewrite visible color in the content stream, so a human should confirm them rather than let them apply blind, especially across a full automated run. |
| **Alt text handling** | **Generate AI alt text**, unless Step 2 said the client supplies their own — then **Guidance only** | Matches whichever path you picked in Step 2. |

There is no link-text control in this popover — link-text always follows the tenant-wide default (Part 10) for every Auto Mode run, with no per-run override.

Click **Start**. The loop now runs on its own: each round analyzes, auto-approves whatever its current settings allow, applies, and **re-audits automatically** — you do not need to click Re-run Audit during or immediately after an Auto Mode run, it already did that internally every round.

### Step 4 — Auto Remediation stops. Which of the 5 reasons was it?

A banner appears on the Audit Results page naming exactly why it stopped. Each one calls for a different next step:

**🟢 Converged — "Auto remediation complete — no more AI-actionable fixes remain."**
This is a genuine success state: nothing is left that the AI pipeline can act on at all (whether by applying or by offering fresh guidance). Go straight to **Step 6**.

**🟡 Round limit — "Stopped: reached the maximum number of rounds."**
There was still more actionable work being found when it stopped. Check the round-by-round history (Part 6, Remediation History card) — is the remaining-issue count still trending down round over round? If yes, click **Start Auto Remediation** again with a higher Max rounds to let it keep going. If the count has plateaued for the last couple of rounds already, treat it the same as **Stalled** below instead of just raising the limit again.

**🟡 Budget limit — "Stopped: reached the cost limit."**
Same shape as round limit, but it ran out of money instead of rounds. If real progress is still being made (resolved count still climbing round to round) and you're comfortable spending more, click **Start Auto Remediation** again with a higher Cost limit. If progress had already flattened before the budget ran out, that's really a **Stalled** situation that happened to also hit the budget ceiling — don't just throw more money at it.

**🟡 Stalled — "Stopped: no further progress was being made."**
The last couple of rounds made no measurable progress at all — Ninja stopped itself rather than keep burning rounds/budget for nothing. This is your clearest, most direct signal that remaining items need a human, not another automated round. Proceed to **Step 6**, then expect to end up at **Step 9 (Acrobat Pro)** sooner rather than later for whatever's left.

**🔴 Error — "Auto Mode stopped on error."**
A real, unexpected failure (shown with its own error message). This is not a normal stop reason — note the exact error text and escalate to engineering/support if retrying doesn't resolve it. Don't treat this as "mostly done, move on." One safety net worth knowing about: if the error happened after some fixes were applied but before they could be verified by the follow-up re-audit, those suggestions are automatically reverted back to "approved" rather than left incorrectly marked as done — so retrying this same job won't silently skip re-trying them.

### Step 5 *(skip this — folded into Step 4 above; kept here only so the numbering matches the stop-reason count)*

### Step 6 — Re-run AI Analysis

On the toolbar, use **Re-run AI Analysis** with its checkboxes set as follows for this workflow:

- ☑ **Include color-contrast auto-fix (re-run only)** — check this. Having reviewed the Auto Mode run's own guidance-only contrast suggestions by this point, use this checkbox to actually attempt a real apply-to-pdf fix for the ones you're comfortable with, instead of leaving every contrast issue as guidance forever.
- ☑ **Include link-text auto-fix (re-run only)** — check this. This is a one-time override for link-text specifically (which, remember, Auto Remediation itself never touched, since it has no per-run control for this category).
- **"Client supplied their own alt text (re-run only)"** — check this only if Step 2's answer was "yes, the client supplies their own." Leave it unchecked if AI-generated alt text is the plan for this job.

Click the button. This fires one single analysis pass (not a loop) and refreshes the suggestions in the Issues panel. From here you either apply each one individually from its own card, or move to Step 7 for a bulk apply.

### Step 7 — Apply Fixes

Use the bulk **Apply Fixes (N)** button (opens the **Apply All Approved** panel — check **"Also include N suggestions awaiting review"** if you want to apply everything eligible without reviewing each one individually first), or apply suggestions one at a time from their own cards in the Issues panel. Either path triggers the same remediation-cycle lock and automatically kicks off a post-fix verification re-audit when it finishes.

### Step 8 — Check the Apply Failure Report

Once Apply Fixes finishes, look at the **Failed (N)** chip in the Issues panel. If N &gt; 0, click **Apply Failure Report** (Part 5.8 has the full detail on reading it). Three buckets matter differently:

- **"Likely already resolved"** — go back to **Step 6** (Re-run AI Analysis again); these should clear on their own once the analysis re-resolves against the current document state.
- **"Correctly skipped"** — working as intended, not a bug. These are the system correctly declining to guess on genuinely ambiguous structure. Leave them; they are not blocking anything.
- **"Needs investigation"** — these are your real remaining candidates for manual attention. Move to Step 9 once this bucket stops shrinking across a repeat of Steps 6–8.

### Step 9 — Decide: loop back, or escalate to Acrobat Pro?

**Recommended rule of thumb** (this is Ninja's own recommended default, not a hard platform rule — adjust to your own team's judgment): after at least one full pass through Steps 6–8, check the Issues panel's **Fixable now** chip.

- If **Fixable now = 0** *and* the total remaining open-issue count is small enough to comfortably fix by hand in the time you have (there's no fixed number — use your own judgment about what "a handful" means for this document and your schedule), **and** the "Needs investigation" bucket in the Apply Failure Report isn't shrinking on a repeat Re-run AI Analysis pass — that combination is your signal to move to Acrobat Pro for what's left.
- If **Fixable now &gt; 0**, or the remaining count is still large, loop back to Step 6 (or, if you have budget/rounds left and the issues look like things Auto Mode handles well, back to Step 3) rather than jumping to manual work prematurely.

In short: **Auto Remediation → Re-run AI Analysis → Apply Fixes → check what's left** is the loop; Acrobat Pro is for the genuine, small residue once that loop stops producing further progress — not a shortcut to skip the loop.

### Step 10 — Download the AI-Fixed PDF

Click **Download AI-Fixed PDF** on the toolbar (only appears once at least one fix has been applied or a remediated file exists). This downloads the document exactly as Ninja has remediated it so far.

> **Blocked by a QC review?** If the job's most recent Team Review verdict is **Needs Correction** (Part 2's QC Shipment Gate), this button is disabled and a direct download attempt is rejected with a clear "blocked" message instead of the file. Address the reviewer's note, then either wait for a follow-up **OK** review or use **Request re-review** (shown on the Audit Results page) to notify the reviewer yourself.

### Step 11 — Fix the remainder in Acrobat Pro

Using the downloaded file, manually fix whatever's left in the "Needs investigation" bucket (and anything else you've decided needs a human) using Adobe Acrobat Pro's own accessibility tools. This happens entirely outside Ninja — nothing on the platform can see this work happening.

### Step 12 — Upload the Acrobat-Pro-fixed PDF back into Ninja

On the Audit Results page, find the **"Manually fixed guidance-only items in Acrobat Pro? Upload the corrected PDF to verify."** card (it's always visible, just below the toolbar area — you don't need to go looking for a separate page for this). Click **Upload Fixed PDF**, pick your Acrobat-Pro-fixed file. This uploads it, and Ninja re-audits the NEW file as a full comprehensive re-validate (not just a quick diff) — expect this to take a minute or two; a loading toast confirms it's working. When it finishes, you'll see how many issues were resolved and how many remain.

### Step 13 — Re-run AI Analysis once more

The upload in Step 12 updates the document and its audit, but the **guidance-only count itself only updates once you Re-run AI Analysis again** (the success message after the upload says this explicitly). Do this now, with the same checkbox choices as Step 6, before moving on.

### Step 14 — Run PAC Desktop

Once the Acrobat Pro fixes are in and verified (Steps 11–13 done), download the current remediated PDF one more time and run it through the real **PAC Desktop** application (the actual axes4 tool, run on your own machine — separate from anything inside Ninja) for an independent, authoritative compliance check.

### Step 15 — Upload the External PAC Report into Ninja

Back on the Audit Results page, open **PAC Report** on the toolbar, switch to the **External PAC Report** tab, and upload the PAC Desktop export (Part 5.9 has the exact upload mechanics and what the summary-count fields mean). This attaches the real, third-party compliance result to the job as a permanent record.

> **Important distinction:** this External PAC Report is a separate record from the **Compliance** phase in the 5-phase stepper. The Compliance phase tracks Ninja's own free, simulated "Ninja Report" (satisfied just by opening that tab) plus the ACR (Step 16) — it does **not** require the External PAC Report upload. Do this step anyway, every time, as the real client-facing proof of compliance; just don't expect it to move the stepper.

### Step 16 — Generate the ACR

Open the **Settings** menu on the toolbar → **Generate ACR**. This takes you into the separate ACR Workflow (Part 8) to produce the formal conformance document. Once both the Ninja Report has been viewed and the ACR has been generated, the **Compliance** phase in the stepper shows **Done**.

### Step 17 — Sign-off

The job is complete once: Auto Remediation has converged or plateaued and been handled (Steps 4–9), the Acrobat Pro residue (if any) has been verified back in (Steps 11–13), the real PAC Desktop check has been run and attached (Steps 14–15), and the ACR has been generated (Step 16). Use the Guided Remediation Checklist (Part 6) as your final at-a-glance confirmation that nothing was skipped.

---

## Part 5 — The PDF Audit Results Page — Full Reference

This part is reference material — come back to it for the exact behavior of any one button, panel, or modal. Part 4 above is the sequence; this is the dictionary.

### 5.1 — Header

File name, page count, file size, and the **Auto-tagged** or **Already tagged** badge, with the **Accessibility Score** card top-right (severity- and page-density-weighted, not a flat issue count).

### 5.2 — Toolbar buttons

| Button | What it does |
|---|---|
| **Create Remediation Plan** | Navigates away to a separate page (Part 7) that groups every issue into Auto-fixable / Quick Fix / Manual sections. Disabled if there are zero issues. |
| **Download Report** | Downloads the full audit result as a JSON file — the raw data, not a formatted document. |
| **Download AI-Fixed PDF** | Downloads the document as currently remediated. Only appears once at least one fix has been applied or a remediated file exists. Disabled if the job's most recent Team Review verdict is Needs Correction (Part 2's QC Shipment Gate). |
| **Share** | Copies the current results page URL to your clipboard. |
| **Re-run Audit** | A full, from-scratch structural re-validation of the current document state. Use this after a manual, outside-the-normal-flow change you want freshly validated — Auto Remediation already re-audits itself every round, so you don't need this during/right after an Auto Mode run. |
| **Re-run AI Analysis** + 3 checkboxes | One single analysis pass with per-run overrides (color-contrast, link-text, client-supplied-alt-text) — see Part 4, Step 6 for the recommended settings. Each checkbox affects only that one click, nothing else. |
| **Start Auto Remediation** | Opens the multi-round automated loop's own settings popover — see Part 4, Step 3. |
| **Settings** | A small menu, currently containing **Generate ACR** (Part 8). |
| **PAC Report** | Opens the 3-tab compliance report modal — see 5.9 below. |

### 5.3 — The 5-phase stepper

**Audit → AI Analysis → Remediation → Verification → Compliance.** A quick-glance summary of where the job stands; the Guided Remediation Checklist (Part 6) is the detailed version of the same journey and is the one to actually work from.

### 5.4 — Pages panel (left column)

Header shows total page count and, in red, total issues + how many distinct pages they're on.

**Filter buttons:** **All** (every page) / **With Issues** (only pages with ≥1 issue) / **Critical** (only pages with ≥1 critical-severity issue — a page with only lower-severity issues won't appear here even with many of them). Only one is active at a time.

**"Jump to..."** — type a page number, click **Go** (or Enter). Out-of-range/non-numeric input is silently ignored.

**Each page entry** shows the page number (plus any custom page label the PDF defines, e.g. "Page 1 (i)"), a colored issue-count badge sized/colored by that page's *highest* severity present (🔴 critical / 🟠 serious / 🟡 moderate / 🔵 minor / none = no issues), a matching colored bar down the left edge, and a hover tooltip with the full per-severity breakdown.

Clicking a page entry selects it, which updates the **Preview panel** to that page. It does **not** filter the Issues panel — use that panel's own Filters → Page field for that.

**Bottom bar:** Previous/Next arrows and a "Page X / Y" readout. Arrow keys (and Home/End) work anywhere on the page as long as focus isn't inside a text box.

### 5.5 — PDF Preview panel (center column)

A real rendered view of the actual page, not a placeholder.

**Toolbar:** Zoom out/in plus a dropdown (Fit Width, Fit Page, 50/75/100/125/150/200%), a Fit-to-page shortcut button, page prev/next + direct page-number entry, and an **"Issues (N)" / Show Issues** toggle (highlights every issue on the current page that has location data — some issue types, like document-level findings, never have one and so never show a box regardless of this toggle).

**On the page:** every locatable issue gets a red-bordered box with a small numbered severity-colored badge (matching its position number in the Issues panel list). Clicking a box selects that issue everywhere else on the page (gold/amber outline added to show it's active). A selected issue also shows a small info strip just below the page with its severity, rule code, element path, and full message.

**Bottom bar:** per-page issue-category pill breakdown (Alt Text, Tables, Headings, Lists, Contrast, Links, Forms, Bookmarks, Language, Reading Order, PDF/UA, Other) with counts, plus a note on how many of this page's issues can actually be located visually.

### 5.6 — Issues panel (right column)

**Header:** filtered issue count, a full-screen toggle, the bulk **Apply Fixes (N)** button (only shown when ≥1 suggestion is eligible), and **Filters**.

**All Issues / Matterhorn-Related toggle:** All Issues = everything every validator found; Matterhorn-Related = only issues tied to formal Matterhorn Protocol codes (and closely related families) — the subset that maps directly to PAC-style compliance.

**Category chips:** Structure, Metadata, Language, Headings, Reading Order, Lists, Tables, Alt Text, Contrast, Links, Forms, Bookmarks, Formula — each shows its count, zero-count categories don't appear, and multiple can be selected at once (combined as **OR**). **Clear categories** resets this.

**"AI:" action chips — All / Fixable now / Guidance only / Applied / Rejected / Failed.** Single-select only (unlike category chips), combined with category selection as **AND**.
- **Fixable now** — apply-to-pdf and still pending — things you could Apply right now.
- **Guidance only** — drafted, will never auto-apply.
- **Applied / Rejected / Failed** — self-explanatory; Failed means it hit the retry cap and is now terminal.

**Apply Failure Report** button — appears only when Failed &gt; 0. See 5.8.

**Filters panel** (toggle open/closed): free-text search, **Severity** (All/Critical/Serious/Moderate/Minor), **WCAG criterion** (All, or any criterion actually present in this document), and a **page number** box. A **Clear** link appears whenever any filter — category, AI action, Matterhorn toggle, search, severity, WCAG, or page — is active.

**Individual issue cards** show: issue number (matches the Preview panel's badges), rule code, severity badge, a provenance badge (Ninja's own check vs. an external validator like veraPDF/pdfa11y), a clickable Matterhorn checkpoint badge where applicable, a clickable page-number badge, the plain-language message, and element path if known. If there's an AI suggestion, a styled panel appears below:
- **Manual Review Required** (amber) — no auto-fix offered at all. For an alt-text issue specifically, if the image needed a subject-matter expert, was blocked by a safety filter, or hit a generic failure, the box also shows AI-drafted **Short alt text** and **Long description** fields (via the standalone Alt-Text Generator) with their own **Copy** buttons — a starting point to review and paste into Acrobat Pro yourself, never auto-applied. If the fallback generator itself can't describe the image either, you just get the plain guidance text with no drafted fields, same as before this existed.
- **AI Auto-Resolved** (green) — already handled, informational.
- **AI Guidance** (blue) — confidence % + guidance text, nothing to click.
- **AI Suggestion** (purple) — apply-to-pdf, with **Approve / Apply / Dismiss** (pending), an "Applied" badge, a "Dismissed" label, or a "Failed" badge + **Retry** button.
- For **alt-text**/**alt-text-improvement** suggestions specifically: the value renders in an **editable textarea** — this is how you substitute client-supplied text (Part 4, Step 2/6).
- A failed suggestion with a recorded reason shows a **"Why did this fail?"** expandable link.

**Bulk Apply Fixes (N)** → **Apply All Approved** dialog: shows scope ("Apply N suggestions... X approved, Y awaiting review"), a **"Also include N suggestions awaiting review"** checkbox (skips the pending-review step too), Confirm/Cancel, and a results screen reporting success/failure counts (auto-closes, longer delay if there were failures so you have time to read them). This also triggers an automatic post-fix verification re-audit.

### 5.7 — Create Remediation Plan

See Part 7 for the full page this button opens.

### 5.8 — The Apply Failure Report

Opens from the Issues panel's own **Apply Failure Report** button (next to the Failed chip). Header reads "N suggestion(s) permanently failed to apply, in M group(s)." Groups (by exact suggestion type + failure reason) are color-coded and sorted most-urgent-first:

- 🔴 **Needs investigation** — doesn't match a known pattern yet, or is a known-but-genuinely-broken case. Worth a look.
- 🟡 **Likely already resolved** — the thing this fix was looking for no longer matches current document state (an earlier fix already changed it, or the document moved since the audit). Re-running AI Analysis typically clears this.
- ⚪ **Correctly skipped** — the fix found a genuinely ambiguous structure and declined rather than risk guessing wrong. Intentional, conservative, not a bug.

Click a group to expand it and see the plain-English explanation, the exact raw failure reason, and the list of affected issue IDs. A **Copy report** button copies the whole thing as text (e.g. to paste into a support ticket). "Nothing has permanently failed on this job" shows when there's nothing to report.

### 5.9 — The PAC Report modal

Opened from the **PAC Report** toolbar button. Title: "Matterhorn Protocol 1.1 Compliance Report." Up to three tabs:

**Ninja Report** (always present) — Ninja's own free, instant, simulated Matterhorn/PAC-equivalent check. A summary bar shows total counts by status (PASS / FAIL / UNTESTED / HUMAN / N/A) across all 137 conditions, followed by a row per checkpoint (CP01 through CP31), each expandable to its own individual conditions and their statuses. A footer note reminds you: *"UNTESTED conditions are not confirmed passing. This report does not constitute full PDF/UA-1 certification."* Simply opening this tab is what satisfies the Compliance phase's PAC-report requirement (Part 4, Step 16).

**axes4 Live Check** *(only appears if your tenant has this paid feature configured and enabled)* — runs the real axes4 engine live, from inside Ninja, against the current document, billed per page. Most operators will never see this tab at all.

**External PAC Report** — upload the real PAC Desktop tool's own export for this document (Part 4, Step 15). There's no automated parser for the uploaded file itself, so you hand-enter its summary counts: **Pass, Fail, Untested, Human Required, Not Applicable**. When totaling a real PAC Desktop export's own Passed/Warned/Failed checkpoint table, map **Warned → Human Required** (that's what PAC itself means by it — flagged for mandatory human review, not a failure) and sum each column across every checkpoint row; PAC doesn't report "Untested" or "Not Applicable" separately, so those two fields are usually left blank. Once uploaded, this tab shows the five counts, a download link for the file you uploaded, and (for the job owner) a **Remove** option.

---

## Part 6 — The Guided Remediation Checklist

Always visible on the Audit Results page (it is **not** the same thing as the "Create Remediation Plan" button, which navigates to a separate page entirely — Part 7). It's purely advisory — nothing elsewhere on the page is gated by it — and exists to tell you, at a glance, where you are in a 9-step sequence and what to do next. While Auto Mode is actively running, the checklist dims with a note that Auto Mode is handling things, since recommending a manual next step would conflict with what the loop is already doing.

Each step shows one of: **Not started** (hollow gray circle), **In progress** (spinning blue loader), **Partially applied** (dashed amber circle — real progress made, nothing currently running, another manual action needed), **Done** (green check), or **Acknowledged** (amber warning triangle — step 6 only). Whichever step isn't Done/Acknowledged gets a blue **"Recommended next"** badge.

1. **Initial audit complete** — always Done (the page's own precondition for existing).
2. **Run AI Analysis** — Done once the first pass has ever completed.
3. **Apply AI-suggested fixes** — In progress (with live counts — "N/M processed · X applied · Y failed") while an Apply Fixes action or an Auto Mode round is actively applying right now; Partially applied once some have landed with others remaining but nothing is currently running; Done once every still-applicable suggestion is gone.
4. **Re-audit to verify** — Done once a re-audit has run since fixes were applied (automatic post-fix pass or a manual Re-run Audit both count).
5. **Re-run AI Analysis (final check)** — Done once AI Analysis has re-run since that verification audit. If new fixable suggestions turn up, a note suggests revisiting step 3.
6. **Resolve guidance-only items** — Done once no guidance-only suggestions remain pending. If some remain, a text field + **"Acknowledge &amp; skip"** button lets you record a reason (e.g. "client will supply alt text separately") and mark them reviewed-and-left-as-is (status becomes Acknowledged, showing the note + who/when). A new guidance-only item appearing later re-flags this step as stale.
7. **Re-audit again to confirm manual fixes** — relevant once step 6 is resolved either way. Since guidance-only/Acrobat-Pro work happens entirely outside Ninja, this step forces one more explicit re-audit so the platform can actually confirm that work landed.
8. **Generate compliance artifacts** — Done once both the ACR and the PAC report exist for this job; shows which one's still missing if only one is done.
9. **Mark comparison trial complete** *(only for jobs linked to a Comparison Study trial — most operators never see this)* — a button, gated on role and on trial data already being logged.

Two companion cards sit directly below:

- **Manual remediation time log** — a self-reported timer ("Log time" opens a form for minutes spent + an optional note), with a running total shown alongside (e.g. "1h 20m logged"). This exists because Ninja's own automatic activity tracking only sees time spent *inside* Ninja — time in Acrobat Pro or any other outside tool is invisible unless you log it here yourself.
- **Remediation History** — a read-only, collapsible "Run 1 / Run 2 / ..." log of every apply/re-audit/AI-analysis cycle, each with its own applied/failed/resolved/remaining/regression counts and timestamps. Only appears once the job has at least one logged cycle; the most recent run is expanded by default. This is where you check whether the remaining-issue count is still trending down (Part 4, Step 4's round-limit/budget-limit guidance) — see also the "Reading the round-by-round Regressions column" note in Part 11.

---

## Part 7 — The PDF Remediation Plan Page

Reached via **Create Remediation Plan** on the Audit Results toolbar (a separate page, `/pdf/{jobId}/remediation` — a "Back to Audit Results" link/button returns you). It regroups every issue into three collapsible sections:

- **Auto-fixable Issues** (green) — "Can be fixed automatically without user input." A primary button here applies every auto-fixable item in this plan's own batch, separate from the Issues-panel's own Apply Fixes.
- **Quick Fix** (blue) — issues with a guided, one-field fix (language, title, metadata, creator) — clicking **Start Quick Fix** opens a small modal to supply that one value directly.
- **Manual Review** (red) — everything genuinely requiring a human judgment call, with per-issue-type counts.

A **Re-audit** control and a **Download Remediated** button also live on this page, independent of the main Audit Results page's own equivalents (they operate on the same job, just from this alternate view). Use this page if you prefer working through issues grouped by *fix mechanism* rather than by category/severity the way the main Issues panel groups them — both views operate on the same underlying job and stay in sync.

---

## Part 8 — The ACR Workflow

Reached via **Settings → Generate ACR** on the Audit Results toolbar. An **ACR** (Accessibility Conformance Report, often called a **VPAT**) is the formal document you hand to a customer or compliance team stating how well the document conforms to a named standard. This is a dedicated 6-step wizard, separate from the Audit Results page:

1. **Edition Selection** — choose which VPAT edition/standard to report against (e.g. VPAT 2.5 INT). May auto-advance if already set upstream (e.g. from a Batch).
2. **Document Upload** — confirm which document this ACR is for (the job you arrived from is pre-selected by default; you can switch to a different already-audited job or upload fresh).
3. **AI Analysis** — review the automated per-criterion confidence analysis Ninja already ran ("View Full ACR Analysis Report" opens the complete report). Read-only at this step.
4. **Human Verification** — just the criteria the AI flagged as needing a human judgment call (not every criterion). Each gets a status, a verification method, and optional notes; every flagged item must be addressed before you can proceed.
5. **Review &amp; Edit** — the full, editable document (remarks/statuses per criterion), with a Version History toggle to see/restore earlier drafts. Finalizing here unlocks the final step.
6. **Export** — **Export Document** (download as Word/PDF/HTML), **Version History**, and **Complete** (back to the dashboard). The exported file is the actual deliverable, downloaded to your machine — it is not separately re-attached to the original PDF job record.

There's no single button back to the Audit Results page from inside this wizard — use normal browser navigation once you're done.

---

## Part 9 — Operational Reports (Admin)

**Who can see this:** Administrators only. **How to get there:** sidebar → Admin → **Operational Reports**.

This is internal operational reporting — how the *system* (speed, cost, reliability, fix quality, team throughput) is performing. It is a completely different thing from the PAC/ACR reports you generate per document (Parts 5.9 and 8) — those describe a *document's* accessibility; this describes how your team and the AI pipeline are running.

Five tabs: **Throughput, Cost, Quality, Reliability, Team Activity**. The first four share a filter bar: From/To date pickers (never later than today), and **Last 30 days** / **Last 90 days** one-click presets (30 days is the default on every tab). A failed load shows a **Retry** button.

### Throughput
**Shows:** a Day/Week grouping toggle; **Queue Wait** and **Initial Audit** cards (average, p95, job count); a **Round Duration by Action** table (AI Analysis / Apply Fixes / Re-audit, each with Avg/p50/p95/Count); a trend line chart of both headline metrics over time; a **Concurrency** bar (live capacity in use, not scoped to your date range); a **Stuck Jobs** list (status + how long stuck, with a **View** button straight to that job).
**Use it to:** check whether the pipeline is keeping up, whether you're near capacity, and to find jobs that have silently stalled.
**Read it as:** the Concurrency bar turns red once units-in-use hits the total — a real ceiling, not just "busy." A rising p95 even with a flat average is an early warning — a growing share of jobs are having a worse-than-typical experience even if most still look fine.

### Cost
**Shows:** four summary cards (Total Spent, Runs, Avg Cost/Run, Avg Cost/Page); a **Cap Hit Frequency** bar chart (converged / round_limit / budget_limit / manual_stop / stalled / error / not-stopped); a sortable **Spend by Run** table (Job, Source — "Comparison Study" or "Production Job" — Cost, Stop Reason, Pages); clicking a row opens the Job Drilldown Dialog (below).
**Use it to:** check real AI spend per document/page before approving a budget change, and to find the most expensive runs worth investigating.
**Read it as:** "converged" stops are healthy; a run that keeps hitting "budget_limit" may mean your cost ceiling is set too low for the documents you're running.

### Quality
**Shows:** a **Yield by Suggestion Type** stacked bar chart (green = Applied, red = Failed, worst-yield-first); a **Stuck Issue Backlog** table (Issue Code, Count, clickable Sample Jobs) for codes that keep failing across jobs whose Auto Mode has already stopped.
**Use it to:** decide which suggestion type is worth the most engineering/process attention next, and to find concrete real documents exhibiting a recurring problem rather than guessing from a bare rate.
**Read it as:** a high failure count isn't automatically "broken" — cross-reference against the Apply Failure Report on individual jobs (many failures are intentional declines, not bugs); this report is for spotting patterns worth investigating, not a verdict on its own.

### Reliability
**Shows:** total interruptions and failures for the range; an **Interruptions** chart (Deploy-interrupted / Crash-interrupted — "infra health, not a user-facing error"); a **Failure Reasons** chart (Size Limit Exceeded / Timeout / Parse Error / Validation Error / Not Yet Categorized, the last shown de-emphasized).
**Use it to:** separate "the AI pipeline is unreliable" from "our own infrastructure interrupted an otherwise-healthy run," and to check whether a failure spike lines up with a recent deploy.
**Read it as:** a large "Not Yet Categorized" bar is expected, not a problem — the failure classifier is deliberately narrow. Chase the named categories, not that one.

### Team Activity
**Shows:** **Team Review Throughput** (one row per Team Leader — green=OK / amber=needs-correction spot-check counts); a **Job Ownership** table (per team member: Total, Completed, Failed, In Progress, Completion Rate, plus a **"Show N assignments"** toggle per person listing their actual job titles/types/statuses with links into each one).
**Use it to:** see how actively each Team Leader is spot-checking their team's work, each person's workload/completion rate, and — critically — whether any specific job is currently **blocked from shipment** by a Needs Correction verdict (Part 2's QC Shipment Gate; also visible on the Cost/Quality tabs' Job Drilldown Dialog, which now has its own Review Status section).
**Read it as:** the "needs-correction" count is not a performance scorecard for the people being reviewed — a low "OK" count for a reviewer could just as easily mean they're genuinely catching problems. But unlike before, a Needs Correction verdict is no longer purely informational: it's an active block until resolved.

### The Job Drilldown Dialog
Opened from a Cost-tab row or a Quality-tab Sample Job link: **"Job History — [job ID]"**, with a **Per-Round Cost** bar chart and a **Score Trend (Resolution Rate)** line chart, both by round number, plus a **Review Status** section showing that job's full Team Review history — including a blocked banner if its most recent verdict is Needs Correction (Part 2's QC Shipment Gate). Use it whenever a summary number makes you want to see what actually happened on *that* job, round by round, or whether it's currently shippable at all.

---

## Part 10 — Settings &amp; Tenant Configuration

Most tenant-wide settings are admin-controlled, but every operator should know they exist, since they're the fallback behind every per-run checkbox/popover described in this guide.

**PDF AI Remediation defaults** (Alt text / Color contrast / Link text, each `apply-to-pdf` / `guidance-only` / `disabled`, alt-text has no `disabled`): this is the fallback used whenever a request doesn't send its own override — the initial automatic pass on upload (Part 4, Step 1) always uses these, and so does **every** Auto Remediation run's link-text category (Part 4, Step 3 — the only category with no per-run popover control). Changing this doesn't affect a run already in progress.

**Require ACR for Compliance** *(admin-only toggle)*: controls whether the Compliance phase (Part 2, Part 4 Step 16) needs both the PAC report *and* a generated ACR to show Done, or just the PAC report alone. Defaults to **on** (ACR required). If your tenant has turned this off, the Compliance phase may show Done without you ever generating an ACR — know which setting your tenant uses so you're not confused by the stepper.

**axes4 PAC Cloud** *(admin-only toggle, paid feature)*: whether the live "axes4 Live Check" tab (Part 5.9) appears at all for your tenant.

---

## Part 11 — Reference: Known-Fixed PAC Issue Categories

These categories were root-caused and fixed against real PAC reports during this platform's own development. If you see one of these flagged, it's already handled by an existing automated fix — you shouldn't need to do anything manual for it.

1. **Annotation tab order not set to `/S`** (Matterhorn 28-008/28-009) — pages with a non-empty `/Annots` array but missing/wrong `/Tabs`. Auto-fixes, confidence 1.0.
2. **Document title not shown in window title** (PDF-NO-TITLE) — including the case where the title field is non-empty but is actually a leaked design-tool export filename (e.g. ending `.indd`). Picked up automatically once flagged.
3. **Figure missing bounding box** — newly-created Figure elements now get a proper layout `/BBox` computed from the image's own position.
4. **Figure missing/empty alt text (decorative case)** — an explicitly empty Alt is retagged as a true PDF/UA Artifact instead, which is what actually satisfies the check (an empty Alt string doesn't).
5. **MCID missing from page / "Entry for given MCID missing"** — a bare MCID whose real page differs from its struct element's own declared page gets repaired, but only when a sibling on the same element already declares the correct page explicitly; genuinely ambiguous or unresolvable cases are left alone rather than guessed.
6. **Heading/caption custom styles flattened via RoleMap** (`ROLEMAP-HEADING-FLATTENED` / `ROLEMAP-CAPTION-FLATTENED`) — an InDesign custom paragraph style mapped to a generic type (e.g. `/P`) in `/RoleMap` is retargeted to its real heading level or `/Caption`. Confidence 1.0.
7. **Generic/auto-generated bookmark titles** (`BOOKMARK-GENERIC-TEXT`) — a bookmark reading something like "Section p.25" is regenerated with the real heading text from its target page, when exactly one unambiguous heading exists there.
8. **"See Chapter 3"-style prose cross-references with no real link** (`CROSS-REFERENCE-MISSING-LINK`) — detected and auto-linked to the actual target heading/page where it can be resolved unambiguously; declines rather than guesses for figure/table references (no resolution path exists for those yet) or an ambiguous match.
9. **Index entries flattened to generic body paragraphs** (`ROLEMAP-INDEX-FLATTENED`) — a contiguous run of custom index-style paragraphs is rebuilt into a real `/Index` &gt; `/L` &gt; `/LI` &gt; `/LBody` structure.
10. **Footnotes flattened to generic body paragraphs** (`ROLEMAP-FOOTNOTE-FLATTENED`) — retargeted to the real `/FENote` type with a `NoteType` attribute set, and the leading footnote number split into its own `/Lbl` where the structure safely allows it. This does **not** yet build the bidirectional link between the footnote and its in-body reference marker — see Part 12.

### Reading the round-by-round "Regressions" column

Auto Remediation's round-by-round history computes "Regressions" as *any issue in the post-round re-audit that couldn't be matched back to the pre-round audit*. A high number here does **not** automatically mean a fix broke something — a known, confirmed-benign pattern is a multi-stage fix chain where fixing one layer of a defect necessarily exposes the next layer as a "new" issue the following round, with the regression count trending to 0 as the chain completes. The actual bug pattern to watch for instead is resolved/regression counts **oscillating** without ever trending toward 0 across many rounds, with the open-issue count stuck flat — that's a known, separate identity-matching issue, not healthy convergence. Either way, don't just trust a final round's "0 regressions" — check whether any issue code that only ever appeared in a Regressions line (never later in a Resolved line) is still open; those are real residuals that won't resolve on their own.

---

## Part 12 — Known Gaps / Open Items

- **Decorative-image alt-text override:** no in-UI path yet to supply real client-provided alt text for an image the AI classified as decorative — its card renders as read-only guidance, not an editable box.
- **Bulk client-supplied alt text:** no mechanism to ingest many custom descriptions at once — per-image manual edit-then-apply only (Part 4, Step 2).
- **MCID-page-mismatch fixer scope:** only catches the "bare MCID whose real page is already declared by a sibling MCR in the same element" pattern; a dangling MCID with no sibling-declared page, or ambiguous across multiple sibling pages, is intentionally left unfixed.
- **External PAC Report vs. Compliance phase:** these are two separate things that share the name "PAC report" — see the callout in Part 5.9 and Part 4, Step 15. Worth double-checking with your own team that this distinction hasn't caused confusion on past jobs.
- **Heading visually styled but tagged with an unrelated style name** (`HEADING-STYLE-MISMATCH`) — detect-only; flags a paragraph that looks like a heading (larger font, short text) but is tagged with a generic/unrelated style also shared by ordinary body text, so no automated retarget is safe. Needs a human judgment call — same bucket as any other guidance-only item.
- **Running headers/footers tagged as real content** (`HEADER-FOOTER-TAGGED-AS-CONTENT`) — detect-only; flags page-repeating header/footer text (a running title, or a plain page number) that's tagged as real content instead of a decorative Artifact. Known limitation: a per-chapter-changing running header (same position, different text each chapter) won't be caught by this check.
- **Footnote bidirectional reference linking:** the footnote structure fix (Part 11, #10) retargets the type and splits the label, but doesn't yet build the required link between a footnote and its in-body citing marker — there's no in-body footnote-marker detector yet. If that specific check matters for your compliance target, a flagged footnote still needs a human to confirm the citation link itself.

---

## Part 13 — Feedback & Defect Reporting

**Where it is:** a floating message-bubble button, bottom-right on every page of the platform. There's also a **Feedback** entry under the **Tools** section of the sidebar (Part 1) that takes you straight to the dashboard described below.

### Filing feedback or a defect

Click the floating button to open the form:

| Field | Notes |
|---|---|
| **Feedback Type** | Accessibility Issue, Alt-Text Quality, Audit Accuracy, Remediation Suggestion, General Feedback, **Bug Report**, Feature Request. Use **Bug Report** for anything that's actually broken. |
| **Severity** *(optional)* | 🔴 Critical (blocks the workflow entirely) / 🟠 High (wrong or misleading result) / 🟡 Medium (confusing or awkward) / ⚪ Low (cosmetic). Leave unset for non-defect feedback types. |
| **Message** *(required)* | Describe what happened. |
| **Context** *(optional)* | Auto-filled with the current page path; add anything else worth knowing. If you're on a job's own page (e.g. the Audit Results page), the job is automatically tagged behind the scenes too — you don't need to paste the job ID yourself. |
| **Attachments** *(optional)* | Up to 5 files, 10MB each — a screenshot is usually the single most useful thing you can attach to a bug report. |

Click **Submit Feedback**. If an attachment happens to fail to upload, the feedback itself is still saved — you'll see a note telling you so, and you can add the file later from the dashboard.

### Tracking what happens next

Everything filed is visible to the whole team at **Admin → Feedback** (or the sidebar's **Feedback** link) — there's no special admin-only gate on this, unlike Operational Reports (Part 9). The dashboard shows:

- Summary stats (total, positive rate, pending review, response rate) and a **By Type**, **By Status**, and **By Severity** breakdown
- A **Requiring Attention** list, sorted with the most severe/lowest-rated items first
- A full, filterable/sortable list (by Type, Status, Severity, and Rating) — click any row to open its full detail, change its status (New → Reviewed → In Progress → Resolved → Dismissed), adjust its severity, add attachments after the fact, or read/add a response

**You'll be notified automatically** (the same notification bell used elsewhere on the platform) whenever something you filed changes status — you don't need to keep checking back on it yourself.

**Admins are notified too, the moment it's filed.** Every tenant admin gets both an in-app notification and an email as soon as new feedback is submitted — not just when its status later changes. You don't need to separately flag your admin that you filed something; it's already reached them.

### When to use this vs. something else

This is the right channel for anything about how the platform itself behaves — a bug, a UI problem, an inaccurate audit finding, or a suggestion. It is **not** a replacement for a job's own Team Review verdict (Part 2's QC gate) — that's specifically about one document's own accessibility quality, not the platform.
