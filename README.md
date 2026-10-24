# Cevrali EHR / EMR

A working outpatient care starter built with React, TypeScript, Express, and Node's built-in SQLite database. It includes practice account setup and staff invitations, a clinical dashboard, patient creation and charts, appointment scheduling and check-in, SOAP encounters, laboratory results, care reminders, insurance verification, prior authorizations, visit billing, audited claim corrections, and an activity log.

This is a **development demo with synthetic records**, not a production clinical system. The published demo accounts have intentionally known passwords. Do not enter real patient information. Lab, pharmacy, messaging, payer verification, claims, and fax connections remain in **demo mode**, as requested.

## Host the website

The full application can be hosted as one web service with persistent storage. See [DEPLOYMENT.md](DEPLOYMENT.md) for the Docker and Render setup on the `cevrali-hosted-demo` branch. The deployment package was checked with practice signup, patient registration, detailed allergy review, and data retention after container recreation. Creating or publishing this development environment does not create a public website address; a hosting account and an actual service deployment are required. A custom domain is optional.

## Open the standalone preview

Build a self-contained interactive HTML preview with:

```bash
npm run build:preview
```

The generated **`preview/cevrali-preview.html`** is an offline browser demo, not a hosted website. Chat and code viewers may show its source instead of executing it. Its scripts, fonts, styles, and synthetic sample records are embedded in the file. When opened by a normal browser, it supports exploring registration, scheduling, charts, notes, and care tasks without a server. Preview changes stay in page memory and **reset on reload**; they do not update the application's SQLite database. No application records or credentials are exported from the working database. Use the hosting instructions above for a normal website address and saved server records.

The root `index.html` is Vite source and cannot run by itself in a file visualization. Publishing a cloud environment preserves files and configuration; live web and API processes must be started again. A live version of the full application requires an environment or host that exposes its web port.

The newest combined review artifact is **`preview/cevrali-patient-profile-preview.html`**, including patient-profile editing, detailed allergy records and change history alongside registration, settings, provider templates, and all clinical, scheduling, revenue, and fax workflows. The builder retains the previous preview filenames with the same current application. In the offline preview, sign out of the demo to create a practice. Accounts and synthetic passwords are temporary page-memory simulations; use demo credentials, keep invitation acceptance in the same tab, and expect a full reset on reload.

## Run locally

Use **Node 24** (`.nvmrc`) and npm. For local scanned-PDF OCR install `tesseract-ocr`, `tesseract-ocr-eng` and `poppler-utils` (for example, `sudo apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils` on Debian/Ubuntu). Missing tools leave scanned documents held for manual review. No external database, API keys, or third-party healthcare credentials are required.

```bash
cd /workspace/Cevrali-EHR-Systems
npm ci
npm run dev
```

The frontend runs on port **3000** and proxies `/api` to the Express API on port **3001**. Use the **Open clinician demo** or **Explore the front desk demo** button on the sign-in screen.

| Demo account    | Email                    | Password           | Access                                                               |
| --------------- | ------------------------ | ------------------ | -------------------------------------------------------------------- |
| Dr. Alex Morgan | `alex@cevrali.demo`      | `CevraliDemo2026!` | Charts, notes, labs, tasks, scheduling, activity                     |
| Jamie Parker    | `frontdesk@cevrali.demo` | `CevraliDemo2026!` | Registration, demographics, scheduling, check-in, insurance, billing |
| Dr. Nina Patel  | `nina@cevrali.demo`      | `CevraliDemo2026!` | Clinical access; a second owner for shared care tasks                |

## Practice and organization accounts

1. On the sign-in screen, choose **Create practice account**. Enter the owner's name, work email, a password of at least 12 characters, and practice contact details. The owner becomes a practice administrator. Select **I also need clinician access** when the owner also needs clinical records, notes, orders, and results.
2. The new workspace starts with **no patients or demo staff**. **Account setup → Practice** manages the name, legal business name, specialty, contact email/phone/address, and optional organization NPI. Signup and this settings page also accept an optional preferred fax provider name and sender number in international format, such as `+14155550123`. These preferences do not connect a service; fax stays in demo mode and no credentials are collected. Confirm the contact details with **Finish practice setup**. Settings use revision checks to prevent overwriting another administrator's changes. Appointments currently use Pacific time.
3. In **Account setup → Team**, invite a clinician or front-desk colleague and optionally grant administrator access. Copy and share the generated link yourself. **No email is sent.** Links expire after 72 hours, are single-use, and can be revoked. Creating another invitation for the same email in that practice revokes the previous pending link. Each staff email currently belongs to one practice.
4. The recipient opens the link, confirms the practice and role, and chooses a name and password. Invitations create access only to the issuing practice. Invite at least one active clinician before scheduling; the appointment form lists that practice's clinicians.
5. Administrators can change another staff member's role, administrator access, and active status. Access changes revoke that member's sessions. You cannot change your own access; the owner always retains active administrator access. Non-administrators can view practice contact details and manage their own password, but cannot list or manage staff invitations.
6. **Account setup → Security** changes your password after checking the current password and revokes other sessions. Sign in using the same work email; the server finds the associated practice. Signing out clears loaded workspace records. A stale tab whose cookie changes to another practice receives an authentication error before it can read or write that practice's data.

Practice identity comes from the authenticated server session. URL parameters, request bodies, and headers cannot select another practice's database. Patient records, appointments, clinical records, workflow settings, finance records, and audit events use separate SQLite files for each practice. The central registry stores membership, profiles, hashed invitation/session indexes, and hashed public-intake routing indexes. Public intake remains limited to its appointment and works without a login. Existing Evergreen demo records remain in the original database.

These are development practice accounts. Email ownership verification, email delivery, forgotten-password recovery, MFA/SSO, subscription charging, multiple-practice membership, and production account administration are not implemented. External healthcare and billing services remain in demo mode. The browser-only preview simulates accounts in memory; persisted server credentials use scrypt and server invitation/session tokens are stored as hashes.

## Patient billing accounts and workers compensation

Patients keep one longitudinal chart with multiple billing accounts: private/personal care and individual workers compensation claims. A practice/organization login account is separate from these patient billing accounts.

1. During **New patient** registration, optionally add private insurance, a workers compensation claim, or both. An existing patient can use **Patient chart → Billing accounts → Add billing account**. Each workplace injury claim gets its own account; prior private coverage stays available for unrelated visits. Registration saves the patient, accounts, coverage and audit entries together, and rejects malformed claim data without a partial patient record.
2. A workers compensation account records the claim number, injury date, employer, carrier, jurisdiction, adjuster contacts, acceptance status and accepted body parts including laterality. Enter accepted parts from the actual claim determination. Pending and denied claims can be retained for follow-up. An accepted claim requires recorded accepted body parts; the app does not determine compensability.
3. In **Schedule → New appointment**, select the patient and **Account for this visit**. Options identify the private payer or workers compensation carrier and claim number. On the date of service, use the appointment row’s **Visit insurance** action to confirm or change the account while the visit is scheduled or checked in. Another patient’s or a closed account cannot be selected. Changes use the previously selected account to prevent overwriting a colleague’s update.
4. Starting the visit carries the scheduled account into the encounter. A clinician can explicitly change a draft’s account before a charge sheet exists. Once an encounter starts, front-desk appointment changes are blocked; the clinician must review the draft. Signed notes and existing billing cannot be silently moved to another account.
5. Workers compensation notes include the claim number, carrier, employer, injury date and accepted body parts. Before signing, the clinician must attest to review, choose the accepted parts addressed at that visit, document injury history/mechanism, assess the relationship to the work injury, and choose work status. Modified duty and off-work status require restrictions and duration. A next review date is optional. SOAP assessment and plan remain required. Other clinical findings can be documented without treating them as accepted body parts.
6. Signed notes retain an immutable claim snapshot and workers compensation documentation, visible in the chart’s **Encounters** tab. Later accepted-part or adjuster updates affect future documentation without rewriting old signed notes. Used claim identity (claim number, carrier, injury date and employer) cannot be changed; add a separate account for a different claim. Close inactive accounts to stop new visit selection while retaining history.
7. In **Insurance**, a workers compensation account has its own carrier/claim coverage entry. Record a **demo coverage check** after acceptance details are entered. Its review has no private-plan copay, deductible or coinsurance. The explicit service-date check is still required before claim preparation. This is a recorded demo review, not live carrier eligibility or authorization.
8. Charge sheets inherit the encounter’s account and only offer coverage from that account. Claim drafts include its claim snapshot and carrier. Corrections cannot switch to another billing account. Workers compensation responses keep patient responsibility at zero in this demo; disputed liability is not automatically transferred to the patient or private insurance. A later personal-care visit can select private insurance again and uses standard documentation and its own private-plan billing.

External claim transmission remains disconnected. The California DWC RFA workflow below is implemented. Other jurisdiction-specific workers compensation reports, compensability determinations, live accepted-condition verification, concurrent private/work-comp payment coordination, and transfer of already billed services across accounts are not implemented.

## Workers compensation RFA and demo fax

The application fills the supplied **California DWC Form RFA, version 01/2014** (`IMR_FormRFAClean.pdf`). It preserves the original two-page template and instructions, adds complete treatment continuation pages, and attaches an equivalent signed clinical narrative. It does not generate a separate PR-2 or Doctor's First Report form. The insurer/URO response area stays blank.

1. Open a workers compensation patient's **Authorizations** tab and add a request using that claim's coverage. Select a **Supporting workers compensation encounter** from the same patient and claim. The encounter may still be a draft. Enter the requested treatment, dates, visit count, and known procedure codes; unknown CPT codes may remain blank for a linked workers compensation RFA.
2. Complete and sign the supporting encounter, including the claim, accepted body parts addressed, work relationship, and restrictions. Signing automatically creates the linked RFA draft. Linking an already signed encounter creates the draft immediately. Patient/claim details, physician identity, assessment, plan, practice contacts, and known treatment codes populate from their sources.
3. The supporting note's physician selects **Review RFA**. Review every service, including office visits, acupuncture, radiology, therapy, or other treatment. Confirm the diagnosis and ICD-10-CM code, exact service, known CPT/HCPCS code, quantity, frequency, duration, rationale, and routing contacts. The app does not infer billing codes from prose. Enter the treating physician's own NPI; the organization NPI is never substituted. Resubmissions, expedited review, and confirmation of prior oral requests require their specific supporting details.
4. Download the draft to review the completed form, full continuation, and supporting narrative. The physician then enters their name and explicitly attests with **Review and sign RFA**. This separate typed electronic attestation does not use a digital certificate. The signed packet is locked; revisions require a new reviewed packet. Patient, claim, policy, or authorization changes block signing/fax preparation until source details are refreshed and reviewed.
5. Verify the displayed recipient and fax number, then choose **Queue demo fax**. The outbox supports simulated failure, retry, and delivery with attempt history. **No fax is transmitted.** Simulated delivery moves the authorization to **Demo submitted**, never approved. Record any demo carrier decision separately; delivery is not treatment authorization.

Clinicians can review clinical content and download PDFs. Front-desk staff see routing metadata and can queue a provider-signed packet, but cannot read the RFA narrative or download the clinical PDF. All packets remain scoped to their practice, patient, and claim. PDF filenames use packet identifiers rather than patient names. Human-readable clinical and signature timestamps use Pacific time.

Fax preferences are saved during practice creation or later in **Account setup → Practice**. A live fax adapter and provider credentials are not implemented. Every exported packet is marked **DEMO — NOT FAXED**. The synthetic example at **`preview/cevrali-rfa-demo.pdf`** is generated from isolated test records, never the working database.

PDF generation uses `pdf-lib` and `@pdf-lib/fontkit`. The original form, embedded Unicode font, and font license are in `server/templates/`; the production build copies them into `dist-server/templates/`. The browser loads its PDF renderer on demand, and the standalone preview embeds these assets so PDF download works without network access. Long treatments continue onto additional pages rather than being silently truncated.

## Reliability fixes

- **Opening the website:** a stalled initial session check now ends with a visible **Retry connection** option. Hosting gateway pages produce a readable service error, and retrying the session check preserves an existing sign-in without repeating registration or other writes.
- **Staff sign-in:** failed passwords are limited by account and connection, so mistakes for one account do not immediately lock other staff out on the same connection. A separate connection-wide limit still bounds failures across different accounts.
- **Corrected reports:** excluding an invalidated source does not make it valid again. A provider explicitly selects **Relink verified report** to copy the latest verified content into the chosen draft, then reviews it again. Inclusion and signature require current nonempty text and matching source provenance/revision. Routine document acknowledgment does not invalidate unchanged content; signed originals and addendum flags remain preserved.
- **Treatment accounts:** a visit with a nonempty service plan locks its billing account after an encounter starts or actual treatment is reviewed. Unsafe switches fail before note/appointment mutation and keep performed approval quantities consumed. Same-account note edits, unplanned draft account changes and pre-visit selection remain available. Historically recorded actuals remain counted even if an older administrative plan release changed its revision.
- **Sessions across tabs:** requests identify the expected practice, user, role and administrator access. A cookie identity mismatch is rejected before reads or writes. Account changes notify other tabs; expired/mismatched sessions clear cached charts. Returning focus verifies the account while masking/inerting the mounted workspace, so an unchanged session retains unsaved note text. Failed checks stay masked with retry/sign-in options. Offline preview remains a separate in-memory demo and does not use shared browser cookies.
- **Double-booking:** ordinary booking checks both patient and clinician overlaps in the creation transaction. Independent patients/providers can share a slot; adjacent visits remain valid. Cancelled and no-show slots release availability. Connected and standalone paths follow the same rule.
- **No-shows:** the queue and appointment/calendar now share a terminal **No-show** status, a dedicated filter and consistent counts/actions. Missed visits do not offer check-in, start, intake or rescheduling actions. Pending outreach and unperformed reservations are released. Startup upgrades the existing appointment constraint additively, preserving records, foreign keys, indexes, triggers and dependent views, and normalizes older queue-only no-show history.
- **Registration retries:** once patient creation succeeds, demographic/insurance/claim fields lock. A failed chart-opening or scheduling refresh retries continuation using the saved patient ID and original tab/booking context; it never repeats registration or silently drops visible edits. Failed creation keeps fields editable.

## Efficiency workflows

### Calendar scheduling and registration while booking

**Schedule** opens a weekly time calendar, with **Day**, **Week**, **Month**, and **List** views. Use the previous/next arrows, **Today**, or the date picker to navigate. Filter by provider and use the existing All appointments / Upcoming / Completed filters. Appointment colors identify status, with text labels and a legend. The selected day's appointment list remains below the calendar for check-in, starting/continuing care, completion, visit insurance changes, and cancellation.

Click an empty half-hour slot to open a booking with its date, time, and selected provider filled in. Month cells have a plus button for scheduling on that date; opening a day header drills into its day view. Open an appointment card for its provider, time, reason, payer/claim and existing visit actions. Front desk can schedule, check in, open the financial patient record, and update visit insurance; clinical visit actions keep their existing role restrictions.

Use **Register & schedule** at the top of Schedule, or **Register new patient** inside a booking, to create the patient without leaving scheduling. Registration retains the selected appointment date/time/provider and any entered visit reason. Optional private insurance and workers compensation registration remain available. After saving, the patient is selected in the booking; confirm the visit account and service authorization review before choosing **Schedule appointment**. Duplicate review offers **Use existing patient for appointment**, so a matching chart can be selected without creating another patient. Registration saves the chart first; cancelling the booking retains the saved patient. A booking conflict can be corrected and retried without registering again. If saving succeeds but refreshing the workspace fails, retry only resumes loading the saved appointment and never posts a duplicate. Selected-day counts and Complete/Cancel actions follow the same provider/status filters as the list. Clinical timestamps and birthdays use Pacific dates consistently across staff browser time zones.

Calendar reads use a bounded inclusive date range (up to 42 days), retain the current practice's access restrictions, and refresh every 15 seconds/on window focus. Overlapping visits from different providers are displayed alongside one another. Same-provider conflicts remain blocked by the scheduling API. The time grid expands for early/late visits; calendar date arithmetic uses clinic date keys across daylight-saving and month/year boundaries. Appointment times use Pacific time. On mobile, day view fits the screen and week/month grids scroll within their panels.

### Rescheduling, recurring appointments and cancellation waitlist

Open an appointment card and choose **Reschedule** before check-in or any encounter/billing work begins. The patient, selected payer/claim, intake and treatment plan stay attached to the original appointment. The new date/time/provider must pass overlap, active coverage, approval-date and remaining-quantity checks. Revision and calendar snapshots prevent overwriting another staff change; the previous slot and reason remain in history. Pending confirmation reminders get the new date/time, day-before due date and readiness status; completed outreach remains historical.

The Schedule tools support weekly or biweekly recurring series of 2–24 appointments. Confirm the patient, payer/claim and treatment plan for the series. Every occurrence is rechecked and reserved in one transaction; any conflict or exhausted allowance leaves the entire series unsaved.

Add a patient to the cancellation waitlist, optionally using an existing scheduled appointment. Specify the account, provider/date/time preferences, duration and priority. Cancelled slots list matching candidates with coverage, intake and authorization readiness. Staff explicitly record an offer and confirm patient acceptance; no SMS/email is sent. Confirmation rechecks the slot and all hard blockers. Outstanding readiness follow-up must be acknowledged. Booking an existing visit preserves its appointment and intake instead of creating a duplicate.

### Actual treatment and billing reconciliation

In an appointment-linked encounter or chart encounter, record each planned procedure as performed, deferred or cancelled. These quantities must total the planned units. Only the encounter author (or assigned provider before an encounter exists) can review actuals; revisions retain their previous snapshots and a reason. Completing a visit alone never invents performed treatment, including for older completed plans.

**Treatment reconciliation** lists missing reviews and differences between performed and charged quantities. Claim preparation, self-pay finalization, claim submission and replacement corrections check the reviewed actuals, current service approval and overall authorization. Overcharging, duplicate quantities and unplanned procedures are blocked. Partial billing remains visible as a discrepancy. To reduce recorded actuals below billed units, first correct or void the billing; then record the actual-treatment revision.

### Signed-note addenda and corrected source reports

The signed original remains immutable. Its author can create a separately dated addendum, record a reason and clinical clarification, reference source reports, then attest using their full account name. Draft edits and signatures retain revision history; signed addenda are locked and displayed with the original note.

Reassigning or correcting a received report already included in a signed note preserves the original copied report and creates an author alert plus a high-priority correction task. Only a signed addendum addressing the flag resolves that task. New RFA preparation/fax review is blocked until the source correction is resolved, and changes to signed addenda require refreshing/reviewing a stale RFA draft. Exported RFA narratives include the signed addenda. If a queued demo fax becomes stale, staff can cancel that queued/failed attempt with a reason, preserve its history, and review/queue a fresh packet. The outbox shows all attempts, including cancelled versions.

### Pre-visit readiness, service allowances, and claim workspace

Open **Pre-visit readiness** to see the selected date's appointments and issues with the specific insurance account selected for each visit. Checks cover contact details, claim acceptance/accepted body parts, a current service-date coverage check, submitted intake, treatment authorization review, and outside documents awaiting clinician review. These are administrative readiness checks, not a clinical clearance. Use **Review visit services** to confirm whether authorization is required. Private/personal visits can explicitly record self-pay; workers compensation liability cannot be moved to patient self-pay through this screen.

In a patient's **Authorizations** tab, record the usual demo approval, then choose **Record service allowance**. Record each approved procedure's category, quantity, counting unit (visits, units, or studies), and decision note. Office visits, acupuncture, therapy, and imaging can have separate allowances under one approval. An allowance must use a procedure on a current approved authorization. Revisions retain history and cannot reduce an allowance below scheduled plus completed treatments or change the procedure/counting unit.

**Schedule → New appointment** shows the allowances for the chosen patient, account, and date. Select **Authorization required**, add the procedures and quantities, and choose their approvals. Valid selections reserve quantities atomically with scheduling; competing or excessive reservations fail without leaving an appointment behind. A service awaiting approval can still be scheduled with **Pending / no approval**, and readiness flags it. Appointment completion retains planned reservations until a clinician records actual treatment. Reviewed performed units consume allowances; deferred and cancelled units release them. Cancellation/no-show releases scheduled holds. Changing visit insurance releases the old holds and requires another review, including when switching back to the original account. Started/completed treatment plans cannot be edited. These scheduling quantities supplement the existing overall claim visit allowance; they do not automatically grant payment or substitute for billing review.

In **Patient chart → Claim workspace**, choose an injury claim to see its accepted body parts, adjuster, treatment requests, separate service balances, visits, RFA fax history, incoming claim documents, and billing status. Clinicians also see the latest signed work-status documentation. Front-desk views retain their clinical restrictions.

### Incoming electronic fax and automatic chart filing

Open **Fax inbox → Receive demo fax** to simulate another facility's incoming connection. Supply received text or attach the original PDF (up to 2 MB and 50 pages). A synthetic patient example is available. PDF text is extracted from the uploaded bytes with `unpdf`; client-supplied extracted text or patient IDs cannot override matching. Originals, SHA-256 digests, receipt references, and filing history persist in the practice's workflow state. Duplicate references/identical originals do not create duplicate chart documents, tasks, or alerts.

Automatic matching requires one unique patient identified by an exact full name and birth date, or MRN and birth date. Any supplied name/MRN must agree. Matching supports labelled `Patient Name`, `DOB`/`Date of Birth`, and `MRN` lines, with ISO or month/day/year birth dates. A labelled `Claim Number` must identify one of that same patient's claims before it can file under that account. Without a claim number, filing stays at the general patient level. Conflicting identifiers, multiple matching patients, unknown claims, unreadable PDFs, or any page without readable text stay in **Needs review**. There is no fuzzy or AI-based identity matching.

Clear matches appear automatically in **Patient chart → Documents**, initially awaiting clinical review. Filing creates a clinician review task and a front-desk alert. The fax bell and inbox refresh every 15 seconds and when returning focus to the app. Each staff member acknowledges their own alerts. Front desk sees receipt/routing/filing metadata; clinical content and original downloads remain clinician-only. Clinicians can resolve uncertain matches or correct a patient/claim filing after reviewing the original, confirming identity, and recording a reason. Corrections retain the original and history and remove it from the previous chart's document list.

Fax preferences still belong to **Account setup → Practice**. Receiving/sending through a live provider, verified callbacks, and external delivery remain disconnected. The connected server uses local Tesseract and Poppler to recognize image-only PDF pages, with recognition confidence and page provenance. OCR text stays in Needs review until a clinician compares every original page, verifies identity and values, and saves the reviewed classification/transcription. Recognition confidence is not a clinical correctness score. Processing is bounded to ten scanned pages per receipt; remaining or unreadable pages require manual transcription. The standalone HTML uses a clearly labelled manual-transcription fallback. Use Receive scanned PDF example to explore either path. Original bytes and all extraction corrections remain retained. A received authorization letter is saved as a document; its text never changes treatment approvals, accepted conditions, medications, diagnoses, or signed notes.

### Lab and radiology reports in provider notes

Draft notes now include **Received lab & radiology results**. When a newly received readable lab/radiology report has a clear patient/account match and exactly one current draft for that account, the original report text populates this section automatically. A general patient report can populate a private/personal draft; a workers compensation draft requires an explicitly matched claim. Old reports are not silently copied forward into later visits. Where several drafts could apply, the provider chooses a received report with **Populate report in this draft**. This copies the report text with its facility, receipt date, and source identifier; it does not generate a clinical interpretation or overwrite SOAP content.

Results recorded/imported through **Orders & referrals** also populate their explicitly linked draft encounter, preserving the recorded test name, value, units, reference range, flag, date, and external reference. Live laboratory delivery remains disconnected. Result review from the note also completes the associated review task.

The note author must **Review and include report** or **Exclude from this note** before signing. The server checks the latest results version at signature time and rejects unresolved or mismatched reports. Included results remain visible in signed encounters and workers compensation RFA supporting narratives. Reports arriving after signing remain in the chart for follow-up and never rewrite the signed note. Correcting a fax's patient/claim filing clears its transcribed text from an unsigned note and requires review again. Original report files remain available from Documents.

All eight efficiency areas are available in the server app and in the self-contained preview:

| Area                         | Workflow                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unified visit workspace      | Open a visit from the queue or schedule. Patient history, medications, allergies, results, intake review, orders, follow-up tasks, vitals, and SOAP documentation stay together.                                                                                                                                                                                                           |
| Templates and smart phrases  | Apply preventive, chronic follow-up, or focused-visit templates. Save custom templates and create reusable phrases. Prompts marked `[[...]]` must be resolved before a note can be signed. Templates never fabricate examination findings.                                                                                                                                                 |
| Pre-visit intake             | Create an appointment-scoped link in Patient queue. The patient can confirm or cancel a scheduled visit and report concerns, symptoms, medications, allergies, and reminder consent. A clinician reviews submissions and explicitly chooses whether to replace the recorded medication and allergy lists.                                                                                  |
| Live patient queue           | Move patients through Waiting, Roomed, Ready, With clinician, Checkout, and Done. Assign rooms and record no-shows. Queue views refresh every 15 seconds; waits use recorded check-in and care-start timestamps.                                                                                                                                                                           |
| Assigned care inbox          | Create tasks with a clinical owner, due date, priority, and category. Filter open, mine, overdue, completed, or all tasks. Reassign work and track completion timestamps.                                                                                                                                                                                                                  |
| Reminder automation          | A server worker runs at startup and every minute. It prepares appointment reminders, creates documentation tasks for notes unsigned for 24 hours, and tracks follow-up reminders. Reminder processing is idempotent. The outbox records consent and manually completed outreach; it never sends email or SMS.                                                                              |
| Faster chart navigation      | Use Ctrl/Cmd+K for patient and encounter search, navigation, and patient favorites. Recent charts and named search views are saved per user. Alt+P opens registration, Alt+N starts a note, Alt+S opens the schedule, and Ctrl/Cmd+S saves an open draft. Global shortcuts pause while a dialog is open.                                                                                   |
| Orders, results, and metrics | Prepare lab, referral, and medication drafts; export FHIR R4 draft bundles; review a final FHIR Observation file or manually record a received result matched to an order and patient. Results create owned review tasks and can be acknowledged. Practice metrics show recorded wait times, no-shows, current unsigned-note and overdue-follow-up backlogs, and measured task turnaround. |

Start with **Patient queue → Create intake link → Open patient view**. In the offline preview, complete the form in the same tab, then use **Return to clinical preview** to review it. Return to the queue, check the patient in, assign a room, mark ready, and open the visit. Record the clinical note and create orders and follow-up tasks from the visit sidebar.

Intake tokens are scoped to one appointment, expire after 72 hours, and are stored as hashes in the server database. Regenerating an unsubmitted intake revokes the old link. Public intake views expose limited appointment information and do not expose the patient chart. A submitted form cannot be silently overwritten. The offline preview simulates the same rules in memory and resets all links and edits on reload.

FHIR exports are **draft documents**, not transmissions or prescriptions. The lab import accepts supported final/amended/corrected Observation files for staff review and rejects mismatched patient/order references. External result IDs cannot be imported twice. Unknown interpretation flags require manual review instead of being assumed normal. Integration settings store provider preferences only; live connections stay explicitly disconnected.

The live server keeps workflow state in an additive `workflow_state` table in the existing SQLite database. Startup preserves existing charts, notes, and appointments. The shared workflow engine powers both the server and browser-only preview. Historical seed records without recorded timing are excluded from wait and turnaround averages; missing measurements display a dash rather than a fabricated zero.

## Insurance verification and billing

Both staff roles can use **Insurance** and **Billing**. Front-desk billing views expose encounter identifiers, dates, and signature status without exposing clinical note content. Existing clinical endpoint restrictions still apply.

You can also manage these workflows directly inside a patient's record:

- **At registration:** select **Add insurance during registration**. If the patient is the subscriber, their name and date of birth populate subscriber details; otherwise enter the subscriber's information. Optionally select **Run a demo coverage check now** and choose the service date and response scenario. The patient, policy, check, and audit entries save in one transaction. Invalid insurance or verification rolls everything back. Successful insured registrations open the patient's Insurance tab automatically. Registration without insurance remains available.
- **In the chart:** choose **Insurance** to add or edit coverage, run checks, and inspect verification history. Choose **Authorizations** to track service approvals. Choose **Billing** to create encounter charges, prepare demo claims, record responses and payments, reverse payment entries, prepare audited corrections, and export statements. The current patient stays selected. Totals and encounter choices include only that patient's records and stay synchronized with the practice-wide finance pages.
- **For front-desk staff:** use **Patients → Insurance & billing**. The patient record contains demographics, Insurance, Billing, and Authorizations. Clinical notes, medications, results, and the New encounter action remain restricted to clinicians.

Newly registered patients can verify coverage before their first visit. Billing starts from an encounter; an empty chart explains that a visit must be created before adding charges. Signing remains required before claim preparation or self-pay finalization.

1. In **Insurance**, add primary or secondary coverage, including payer, plan, member/group IDs, subscriber details, and effective dates. Overlapping policies at the same priority are rejected. Editing coverage preserves previous verification responses and requires another check.
2. Choose **Check coverage**, enter the visit's service date, and select an explicit demo response: Active, Inactive, or Needs review. Responses include a reference and timestamp. Active responses show sample benefits ($25 copay, $500 deductible remaining, 20% coinsurance). These are simulated estimates; they never set the actual patient balance. Dates outside the policy period return inactive.
3. In **Billing**, create a charge sheet from an encounter and choose Insurance or Self-pay. Enter staff-reviewed CPT/HCPCS and ICD-10-CM codes, units, and fees. The app checks format and integer-cent amounts, not coding accuracy. Codes and fees are never inferred from the note.
4. Sign the encounter before preparing a claim or finalizing self-pay. Insured claims require primary coverage and an active check for that policy version and service date within the last seven days. Charge sheets lock after preparation/finalization. Duplicate charge sheets and claims are rejected. If coverage changes afterward, verify it again and use **Refresh claim coverage**; the previous snapshot remains available in the draft export.
5. **Simulate submission** records a demo event without transmitting anything. Record an approved or denied demo payer response. Approved insurer payment, contractual adjustment, and patient responsibility must exactly match the claim charges. Denials post no money and appear in the billing worklist for documented follow-up and demo resubmission.
6. Record an external patient payment only after responsibility is assigned by an approved response or self-pay finalization. Overpayments, duplicate references, repeated remittances, and repeated reversals are rejected. Payment entries stay in the ledger; reversing an entry appends a correction and does not issue a refund. Do not enter card or bank details.
7. Filter the worklist by patient or status. Review charges, recorded payments, outstanding balances, service-date age, and patient amounts due. Unallocated charges are shown separately from patient responsibility. Export JSON claim drafts and patient statements for inspection; neither is sent externally.

Try **Olivia Bennett / enc-001**, whose synthetic encounter is already signed: add coverage, verify today's service date, create an insured charge sheet with a reviewed $150 charge, prepare and simulate the claim, then record $100 insurer payment + $25 adjustment + $25 patient responsibility. Record a $25 patient payment to bring the balance to zero. The visit editor's **Billing** tab summarizes the patient's coverage and balances.

The demo does not implement live X12 270/271 eligibility, 837 claim submission, 835 remittance import, real-time payer status, secondary claim coordination, live prior authorization or corrected-claim delivery, refunds, or payment processing. Claim exports are explicitly marked demo JSON, not valid 837 files. Use a payer/clearinghouse and payment integration for live services.

## Settings and provider templates

Open **Settings** in the sidebar or the workspace gear. **Personal preferences** saves each staff member's start page, default day/week/month/list calendar view, table density, and reduced-motion preference within their practice. The start page applies when signing in without a specific page link; explicit links keep their destination. Server preferences survive sign-out and restart. Offline-preview changes reset on reload.

**Practice details** includes organization contact information and demo fax provider/sender preferences. **Team & access** is available to administrators for invitations and staff roles; **Security** changes the signed-in user's password. **Connections** shows lab, pharmacy, and reminder preferences to staff, with changes restricted to practice administrators, including front desk administrators. All external delivery remains in demo mode. Existing Account setup and Integrations links remain compatible.

Providers can use **Settings → Templates & phrases** to create, edit, duplicate, preview, archive, and restore SOAP templates and smart phrases. New items default to **Personal**; choose **Practice** to share with the clinical team. Only the author or a clinical administrator can edit shared items. Personal items remain hidden from other staff, including other administrators. Concurrent edits require the current revision. Archived items leave the note pickers but remain available in the library's archived view.

Select a saved template or phrase in an encounter's documentation tools. Updating a library item changes future insertions and never rewrites existing notes. The workers compensation starter provides generic prompts for claim number, accepted body parts, actual examination, work status, and treatment rationale; the visit's structured workers compensation documentation is still required. Use generic `[[prompts]]` rather than patient identifiers or presumed findings. Providers must resolve prompts and review inserted text before signing.

## New patient creation

Use the **New patient** button in the workspace header from any page. Enter demographics, optionally capture insurance and a demo coverage check, then register. The new record opens automatically; the traditional **Patients → Register patient** entry also remains available. A checkbox controls opening the record for registrations without insurance. Insured registrations open the Insurance tab.

Address entry includes separate **Address**, **Unit / Apt number**, **City**, **State**, and **ZIP code** fields. State choices include U.S. states, territories, and military address codes. ZIP accepts five digits or ZIP+4 and preserves leading zeros. Each component is stored separately and displayed together in the patient record. Existing free-form addresses are retained without guessing their components.

Clinical registration includes a searchable, multi-select **Known allergies** dropdown with 267 common medication, food, environmental, venom, and contact/material allergens and medication brand aliases. Select an option to add it, or choose **Other**, type a name, and select **Add allergy**. Duplicate names are prevented, selections can be removed, and an unfinished custom entry must be added or canceled before registration. The catalog is an entry aid rather than an exhaustive terminology service; blank selections mean no allergies recorded. The same form is used when registering a patient while scheduling.

Before creating a record, the app checks for existing patients with the same normalized first/last names and date of birth. Staff can open the existing record or explicitly confirm a separate patient. The API enforces the same check in the registration transaction and audits confirmed separate records. The check is a duplicate warning, not identity proof or automatic patient merging. Changes are never silently applied to an existing patient.

## Patient editing and detailed allergies

Open a patient chart or front desk patient record and choose **Edit patient details** to correct names, birth date, contact details, or the structured address. Every change requires a reason and preserves the patient's identifier, clinical records, coverage, and financial history. Name/birth-date changes check for other matching identities and require an explicit separate-person acknowledgment when needed. Contact-only corrections do not repeat that acknowledgment for intentionally separate matching patients. Stale updates are rejected while retaining the draft; a saved update with a failed chart refresh can retry the refresh without repeating the change.

Clinical users have an **Allergies** tab for reaction, severity, allergy/intolerance/unconfirmed classification, information source, onset date, notes, and active/inactive/entered-in-error status. Previously recorded names remain unconfirmed until reviewed; blank lists are **Not reviewed**, and **No known allergies** requires an explicit current review with no active entries. Saving a review records who reviewed it and when. Removed entries remain inactive with their previous details retained. Changing the list or details clears the prior review unless a fresh review is recorded. Unsaved allergy edits, including pending custom entries, prompt before leaving the tab or chart.

The chart strip and visit workspace show current allergy status and recorded reaction/severity. Intake reconciliation retains details for matching active names, archives removed entries, and records newly reported names without silently reactivating older inactive/error entries or confirming absence. Changes do not rewrite signed clinical text.

**Change history** shows actor, time, reason, and before/after values. Front desk staff can edit demographics and see demographic history; clinical allergy details and their history remain restricted to clinical users. Profile revisions, records, and history persist in the practice's workflow database and run through the same rules in the offline preview, where all changes reset on reload.

## Prior authorization tracking

Open **Authorizations** in main navigation or inside the patient record. Create a request with coverage, procedure codes, description, requested dates, requested visits, follow-up deadline, and staff owner. Drafts can be edited with stale-update protection. Simulate submission and record an explicitly simulated approval or denial, including the approval number, approved dates, visit allowance, and decision note. All changes append history with actor and time.

The worklist filters draft, submitted, approved, denied, cancelled, expiring within 14 days, expired, follow-up due, or exhausted requests. It shows reserved and remaining visits. Staff identify whether a service requires authorization; the app does not infer payer rules. In a charge sheet, select **Prior authorization required for these services** and link the approval. Claim preparation and submission check patient/policy/version, service dates, every charge's procedure code, and remaining visits. Each prepared claim reserves one visit regardless of charge-line units. Approval is not a guarantee of payment. A reserved authorization cannot be cancelled until the claim is replaced or voided to release it.

## Audited claim corrections

Use **Billing → Manage billing → Correct claim**, including inside the patient chart:

- **Draft revision:** revise a prepared claim before its first submission. Applying the reviewed change creates a new prepared claim and keeps the prior draft and its original charges in history.
- **Replacement:** correct a submitted, denied, or adjudicated demo claim. Enter reviewed corrected codes/charges, primary coverage, any required authorization, and a reason. Preparing/submitting the correction leaves the original billing intact. An accepted demo response creates a replacement claim awaiting its own remittance; a rejected response preserves the original amounts.
- **Void:** simulate cancellation of a submitted claim. Acceptance records the void, reduces effective charges to zero, and releases its authorization reservation. Original claim lines, versions, and audit history remain available.

While a correction is open, competing payment posting, receipt reversal, and original claim mutations pause. Unsubmitted corrections can be cancelled. Submitted corrections require a recorded accepted/rejected demo response. Dates, coverage freshness, authorization allowance, and source revision are checked again before applying a replacement.

Accepted replacements and voids append insurer-payment and contractual-adjustment reversal entries. They never delete old postings. Patient receipts remain as unapplied payments until replacement adjudication; overpaid amounts become a visible credit balance. New payment entries cannot overcollect that balance. Credits require staff review and any refund must occur outside this demo. A simulated correction acceptance does not represent a real payer acknowledgment, insurer recoupment, or refund.

## Try a complete workflow

1. Open the clinician demo and register a patient from **Patients**.
2. Open their chart to review demographics, allergies, conditions, recorded medications, encounters, and results.
3. Create an appointment from **Schedule**. Choose a free time; overlapping provider appointments are rejected. The clinic uses **America/Los_Angeles** time.
4. Check the patient in, then start the visit. Starting the same appointment again reopens its existing note.
5. Document the chief complaint, vitals, and SOAP sections. Save a draft, reopen it, and confirm the content persists.
6. Add an assessment and plan, then sign the note. Signing requires confirmation and locks the note against further edits.
7. Mark the visit completed in Schedule. Care inbox reminders are managed separately from notes and visits.
8. View **Activity log** to inspect chart access and changes.

## Build and verify

```bash
npm run build        # Type-check, compile the server, and bundle the frontend
npm test             # API integration tests using isolated temporary SQLite databases
npm run test:e2e     # Chromium clinical workflow, role restrictions, and mobile layout
npm run test:preview # Build the standalone HTML and verify it without network access
npm run smoke        # Verify a running development server through port 3000
```

Browser tests use `/usr/bin/chromium` when available. Else install Playwright Chromium with `npx playwright install chromium`. Set `CHROMIUM_PATH` to use another installed Chromium. The end-to-end suite starts its own built server on port **3100**, uses a unique temporary database, and leaves the development database untouched. Run the build before the browser suite.

Validation includes **185 API/rules tests**, **41 full-application browser tests**, and **23 standalone-preview browser tests**. The connected browser journeys cover intake, clinical reconciliation, queue movement, templates and phrases, follow-up creation, order/result review, task ownership, reminders, metrics, favorites, saved views, coverage checks, claim denial/resubmission, remittance, patient payment, reversal, and finance access on mobile. Chart journeys cover insured registration, authorization approval/reservation/release, encounter signing, claim replacement/void, retained patient credits, and duplicate-patient review. Standalone tests block network requests and verify the same workflows offline. Account tests cover empty-practice signup, invitations, staff permissions, session revocation, password changes, public-intake routing, practice separation, cross-tab session changes, mobile settings, and restart persistence. Workers compensation tests verify registration rollback, account separation, schedule changes, note requirements, carrier selection, immutable snapshots, liability restrictions, return to private insurance, and restart persistence. RFA tests cover practice fax preferences, draft creation only from signed documentation, patient/claim isolation, treating-physician review, separate attestation, stale sources, flattened PDF output, long-treatment continuation, fax recipient confirmation, failure/retry, and simulated delivery without approval. Operations tests cover exact/ambiguous fax matching, original PDF extraction, unreadable pages, duplicate receipts, per-user alerts, clinical permissions, corrected filing, source-linked note results, signed-note immutability, lab-order result transcription, service-specific reservations, insurance changes, completed quantities, self-pay boundaries, readiness, persistence, and practice isolation. The new connected/offline journey covers registration through approval, scheduling, readiness, claim workspace, incoming PDF, provider review/signature, front-desk alerts, and mobile layout. Calendar checks cover inclusive/bounded range queries, authentication/practice isolation, daylight-saving and month/year navigation, overlapping provider layout, early/late hours, provider/status views, date/time prefilling, registration while booking, duplicate reuse, conflict retry, front-desk details and mobile layouts in both connected and offline journeys. API tests also cover rollback, patient scoping, approval limits, immutable correction history, competing-post protection, policy changes, stale updates, additive migration, access control, and database reopen persistence. New coverage verifies booking-refresh retries, filtered actions, Pacific timestamps, all-or-nothing recurring bookings, rescheduling reminders, waitlist offers and edits, actual treatment/billing discrepancies, signed addenda and immutable report corrections, stale fax cancellation/replacement, and real local OCR plus the offline transcription fallback.

Settings coverage verifies staff/practice isolation, administrator-only integration changes, persistence, start-page routing and explicit links, calendar/display preferences, private/shared template ownership, stale-edit rejection, archive/restore, and applying templates without rewriting existing notes. The same provider template journey runs offline with network requests blocked.

Registration coverage includes additive address migration with existing rows/indexes/triggers/views preserved, separate-field persistence, leading-zero ZIPs, invalid address rollback, allergy search/keyboard selection, manual-entry confirmation, duplicate prevention, mobile layout, and retaining addresses/allergies across saved-registration retries.

Patient-profile coverage verifies demographic duplicates and no-op behavior, per-section revision conflicts, private clinical history, detailed allergy validation and NKA attestation, intake reconciliation, old inactive/current active entries, restart persistence, unchanged signed notes, pending/edited draft navigation protection, and committed-save refresh retries without replay.

To serve the built application and API from one process:

```bash
npm run build
npm start
# In another shell, verify the built server:
SMOKE_BASE_URL=http://127.0.0.1:3001 npm run smoke
```

## Persistence and configuration

On first API startup the database schema and synthetic records are created automatically. Records, notes, tasks, audit events, and sessions persist in the ignored **`.data/cevrali.sqlite`** database. Startup is idempotent and does not reseed an existing database. Live processes must be restarted after restoring a cloud environment snapshot.

Practice profiles, staff membership, invitations, and routing indexes persist in **`.data/cevrali.sqlite.accounts/accounts.sqlite`** by default. Each new practice has its own **`practice-<UUID>.sqlite`** file in the same directory, created without demo patients or demo users. Retain the complete accounts directory together with the original demo database, including SQLite WAL state while processes are running. Do not copy these records into a preview artifact. Account migrations preserve the existing demo database.

Set optional variables in the shell or cloud environment settings; `.env` files are not loaded automatically.

| Variable         | Default                    | Purpose                                                                                         |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`  | `.data/cevrali.sqlite`     | SQLite filename, relative to the working directory or absolute                                  |
| `ACCOUNTS_PATH`  | `<DATABASE_PATH>.accounts` | Directory for the account registry and per-practice databases; retain it with the main database |
| `PORT`           | `3001`                     | API / built-server port; the development proxy expects 3001                                     |
| `COOKIE_SECURE`  | unset                      | Set to `true` when serving behind HTTPS to require secure session cookies                       |
| `CHROMIUM_PATH`  | detected                   | Optional browser executable for end-to-end tests                                                |
| `SMOKE_BASE_URL` | `http://127.0.0.1:3000`    | Target origin for the internal smoke check                                                      |

Dependency installation needs `registry.npmjs.org`. Git reads use the platform's existing GitHub HTTPS authentication. Fonts are bundled locally; no runtime external font or healthcare services are needed. Downloading Playwright browsers on other machines may require the Microsoft Playwright CDN; this cloud machine uses its preinstalled Chromium.

## Implementation

- `src/`: responsive clinical workspace, sign-in, patient chart, registration and appointment forms, note editor.
- `server/accounts.ts`, `server/platform.ts`, `server/account-model.ts`: practice registry, session-selected database routing, account validation, staff invitations and access management.
- `src/accounts-ui.tsx`: practice signup, invitation acceptance, practice profile, team access and password settings.
- `src/settings-ui.tsx`, `server/settings-model.ts`: central Settings hub and validated, per-staff workspace preferences.
- `src/template-settings.tsx`, `server/template-library.ts`: personal/shared SOAP templates and smart phrases, ownership, revision checks, and archiving.
- `server/patient-demographics.ts`, `src/allergy-picker.tsx`, `src/allergy-catalog.ts`: structured addresses and searchable/custom registration allergies.
- `server/patient-profile-model.ts`, `server/patient-profile-engine.ts`, `src/patient-profile-ui.tsx`, `src/patient-allergies-ui.tsx`: revision-safe demographic editing, detailed allergy review, intake preservation, and private change history.
- `server/database.ts`: schema, synthetic seed records, and password hashing.
- `server/app.ts`: validated API, sessions, role authorization, workflow transitions, and audit events.
- `server/workflow-engine.ts`: shared workflow rules, validation, templates, automation, metrics, scoped intake, and draft FHIR export.
- `server/finance-engine.ts`: shared insurance, eligibility, charge sheets, claim lifecycle, remittance reconciliation, statements, and append-only payment ledger rules.
- `server/patient-accounts.ts`, `src/patient-accounts-ui.tsx`: patient billing accounts, workers compensation claim details, visit account selection, and documentation requirements.
- `server/registration.ts`: shared normalized-name/date-of-birth duplicate matching with demographic-only results.
- `server/workflows.ts`: transactional SQLite persistence and authenticated/public workflow routes.
- `src/workflow-ui.tsx`, `src/order-tools.tsx`: queue, intake, assigned tasks, reminder outbox, navigation tools, visit context, orders/results, metrics, and demo integration preferences.
- `src/finance-ui.tsx`: insurance coverage and verification history, billing worklist, charge entry, demo claims, payer responses, manual payments, reversals, and visit finance summary.
- `src/insurance-fields.tsx`: shared policy fields and optional registration-time insurance and demo verification inputs.
- `src/authorizations-ui.tsx`, `src/corrections-ui.tsx`: authorization worklists, request/decision history, approval linking, audited charge revisions, and demo replacement/void review.
- `server/index.ts`: database initialization, HTTP startup, and built frontend serving.
- `tests/`: API and browser workflows; test databases are isolated from application data.
- `scripts/smoke.mjs`: live readiness check that exercises sign-in and representative reads, then signs out.

The demo implements scrypt password hashing, hashed session tokens, eight-hour HttpOnly/SameSite cookies, sign-in throttling, same-origin JSON writes, server-side role enforcement, parameterized SQL, and a local audit log. Signed notes are immutable through the API, and stale draft updates are rejected.

Before clinical deployment, this starter needs a production identity and access design, removal of public demo accounts, encryption and key management, backups and recovery, protected audit storage and retention, clinical validation, applicable compliance review, and live interoperability services. E-prescribing transport, external lab delivery, live payer/claims services, a full authenticated patient portal, live FHIR/HL7 connections, certificate-based note signatures, and production hosting are not implemented. The scoped intake form is a limited self-service workflow, and local FHIR draft export/result review is not a live connection. The local audit log is not tamper-proof or a complete compliance system.
