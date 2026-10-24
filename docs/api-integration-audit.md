# HCM Lite frontend–backend integration audit

## Scope and evidence

This audit inspects the active, separate `HCM-frontend` and `HCM-backend` repositories. It maps the actual calls in `components/Workspace.jsx`, `components/Auth.jsx`, `lib/api.js`, `lib/biometrics.js`, the attendance components and native CSV/PDF download links to Express routes and MongoDB services. All API paths below are relative to `/api`. Backend source is `src/routes/index.js`, `src/routes/publicAuthRoutes.js`, `src/routes/biometricRoutes.js`, `src/routes/aiRoutes.js` and the services they invoke.

An endpoint existing in source is not, by itself, a passing end-to-end test. The verification section distinguishes source review, existing regression coverage and tests actually run for this audit. No production seed records, stubbed business APIs or fabricated business statistics are used. Isolated transport/error fixtures are identified explicitly in the verification results.

## Findings at the start of the audit

| Area | Observed implementation / defect | Final resolution |
| --- | --- | --- |
| Company onboarding | First-run `GET/POST /setup` existed, but it refused initialization after any company existed, did not establish a session, and there was no `/register` page or public registration endpoint. Company `singleton` default was globally unique. | Added real per-company registration, unique company identity, linked Admin account and authenticated session; preserved legacy first-run setup. Actual API/browser registration passed. |
| Password recovery | `/forgot-password` was an informational page directing users to Admin; no public forgot/reset API or reset-token page existed. | Added real configured SMTP delivery, hashed expiring single-use tokens and reset flow. Missing delivery returns a clear 503; the browser flow passed with an isolated actual SMTP receiver. |
| Account activation | Existing Admin `PATCH /users/:id` already activates/deactivates HR and employee logins. New employee logins are active and must rotate their temporary password. | Preserved and tested Admin activation/deactivation plus forced temporary-password rotation. No separate email-activation flow is claimed. |
| Login initialization | `Auth.jsx` automatically requested `/setup`; its catch displayed the API-client message before submission. It did **not** request `/auth/me`. The API client attempted JSON parsing regardless of content type and converted parse failures to “The service returned an invalid response.” | Fixed runtime proxy/base-URL handling and auth initialization. A normal 401 is unauthenticated; real service failures remain visible and actionable. Exact original-error reproduction and fixed outage behavior passed. |
| Session restoration | `Workspace.jsx` stored only the error message, then redirected to `/login` for every identity error, including network/502/invalid-response failures. | Only 401 redirects to login. Other failures show Retry; actual backend-outage and restored-recovery browser checks passed. |
| Department dashboard filter | `dashboardService.js` reused a URL-string department ID in a Mongo aggregate. `find()` cast it, but aggregation did not, producing zero headcount/average salary while other department data existed. | Validated/cast the department ID before aggregate filters; real MongoDB regression passed. End-date grouping populations also align with headcount. |
| Legacy attendance board | `attendanceService.board()` iterated only current working days and used the UTC date cutoff, hiding persisted rows after calendar-policy changes and potentially omitting a company-local date ahead of UTC. New analytics already retained these rows. | Preserved actual saved rows and approved leave, using company business dates consistently; synthesized absence still requires a real eligible working date. Regression checks passed. |
| Correction action | HR saw “Review” for every pending correction, while the backend correctly rejected self-approval. A promoted employee can retain a pending self correction. | Hidden the unusable self-review action; backend self-approval protection remains in place. |
| Favicon | App Router still included the stock `app/favicon.ico`. | Replaced with matching HCM Lite SVG/multisize ICO and title metadata; actual production icon bytes/head tags and mobile layout passed. |
| Recovery after login-email changes | HR employee edits originally changed User.email without revoking account versions, so a newly introduced reset link sent to the former mailbox could remain valid. | Email changes now revoke sessions/reset links; the focused 9-check authentication suite passed after this hardening. |

No other currently implemented frontend business action was found to lack its corresponding Express endpoint. The matrix below records the existing contracts rather than inferring them from page names.

## Shared security and error contract

Authenticated routes run behind `authMiddleware`: the JWT comes from the `hcm_session` HttpOnly cookie (Bearer remains a supported API alternative); HS256, expiry, active account, token version and company assignment are checked. Cookie settings use `SameSite=Strict`, `Path=/`, eight-hour expiry and `Secure` in production. Password rotation is required before ordinary business routes.

The authenticated company is installed in `AsyncLocalStorage`. `companyPlugin` intersects every supported model query with that company, assigns company ownership on validated new documents and scopes aggregates. Employee-facing reads additionally restrict the employee ID. API code validates foreign department/designation/employee references before writes. Public login and recovery identify accounts by globally unique email; registration creates an explicit company assignment. Login emails intentionally remain globally unique across companies.

Mutation requests with an untrusted `Origin` receive 403. CORS uses configured `FRONTEND_URL` origins and credentials. The browser should call the same-origin `/api` proxy; database URLs, JWT signing keys, reset-token hashes and biometric templates stay on the server. Native download links use the same proxy and cookie session.

Expected errors are JSON: unauthenticated/expired/revoked session 401; role, ownership or origin rejection 403; missing scoped record 404; duplicate/decided/locked workflows 409; invalid fields/business conditions 422; rate limits 429; missing optional runtime or delivery/provider configuration 503. Unexpected failures use a generic 500 message without database credentials or biometric payloads. Malformed/non-JSON proxy responses need a clear service error rather than a fabricated success result.

## API integration matrix

`A` = Admin, `H` = HR, `E` = Employee. “All” means an authenticated account that has completed temporary-password rotation, unless stated otherwise. “Self” is always checked by the backend. All business collections listed below are company scoped.

### Registration, authentication and activation

| Frontend feature / source | Method and endpoint | Request | Successful response / persistence | Access and failure boundaries |
| --- | --- | --- | --- | --- |
| First-run discovery (`Auth`) | `GET /setup` | None | `{required:boolean}` from actual Company existence | Public; service/DB failures are not an unauthenticated state. |
| Legacy first-run company creation (`Auth setup`) | `POST /setup` | `{company:{name,...policy},name,email,password}` | 201 company/Admin/default leave policies and audit; legacy response initially instructed sign-in | Public, rate limited; atomic creation, 409 when already initialized. |
| Register company (`/register`, added by this audit) | `POST /auth/register` | `{company:{name,...policy},name,email,password}` | 201 persisted Company + linked Admin, default leave policies, audit and authenticated cookie session; public user view | Public, rate limited; strict body/password validation and duplicate-email rejection. No client-selected role/company ownership. |
| Login (`Auth`) | `POST /auth/login` | `{email,password}` | Public user view `{_id,name,email,role,employee,company,active,mustChangePassword}` + cookie | Public, rate limited; invalid credentials/inactive login 401, no password hash response. |
| Session restore (`Workspace`, login initialization where applicable) | `GET /auth/me` | Cookie | Same public user view from User | Allows temporary-password account; absent/invalid session 401 is normal unauthenticated state. |
| Logout (`Workspace`) | `POST /auth/logout` | Empty | `{message}`, User token-version increment, cookie removal and AuditLog | Authenticated, including temporary-password account; all prior JWTs for this account become invalid. |
| Change/rotate password (`Password`) | `POST /auth/password` | `{currentPassword,password}` | Updated public user view + renewed cookie; hash/version/must-change update and audit | Authenticated, including temporary-password account; wrong current password 422. |
| Request password reset (`/forgot-password`, added by this audit) | `POST /auth/forgot-password` | `{email}` | Generic accepted response after configured real delivery; hashed expiring one-use recovery state only | Public, rate limited; no token in public response, no invented mail success when delivery is unavailable. Final delivery configuration is listed below. |
| Complete password reset (`/reset-password`, added by this audit) | `POST /auth/reset-password` | `{token,password}` | Password update, consumed token, revoked old sessions and renewed authenticated cookie/public user view | Public, rate limited; expired, invalid, used or inactive-account token rejected. |
| Login-management list (`Users`) | `GET /users` | None | User views, including active and must-change status | A only; company scoped, secrets excluded. |
| Create/promote HR (`Users`) | `POST /users` | `{name,email,password,employee?}` | 201 HR user view; new hash or existing employee-login promotion; must-change, version and audit | A only; linked employee must exist in company and have an employee login. |
| Activate/deactivate/reset temporary password (`Users`) | `PATCH /users/:id` | `{active?,password?}` | Updated user view; token revocation, audit; deactivation queues enrollment removal | A only; Admin account cannot be reset/deactivated through this route, foreign IDs 404. This is the implemented account-activation mechanism. |

### Company policy, organization and employee management

| Frontend feature / source | Method and endpoint | Request | Successful response / persistence | Access and failure boundaries |
| --- | --- | --- | --- | --- |
| Company policy (`Settings`) | `GET /company` | None | Company policy document | A/H; company scoped. |
| Edit company policy (`Settings`) | `PUT /company` | Strict company policy: name, officeStart/End, timezone, maxShiftHours, graceMinutes, halfDayHours, weekend array, radius, optional coordinates, biometricRetentionDays | Updated Company + before/after AuditLog | A only; valid IANA timezone, bounded coordinates/radius/hours. UI converts comma-separated weekend to numbers. |
| Department catalog (`Catalog`, employee/HR forms) | `GET /departments` | None | Department array `{_id,name,...}` | A/H; company scoped. |
| Department creation/edit (`Catalog`) | `POST /departments`, `PUT /departments/:id` | `{name}` | 201/200 persisted Department + audit | A only; name uniqueness is per company; foreign edit 404. |
| Designation catalog (`Catalog`, employee/HR forms) | `GET /designations` | None | Designation array | A/H; company scoped. |
| Designation creation/edit (`Catalog`) | `POST /designations`, `PUT /designations/:id` | `{name}` | 201/200 persisted Designation + audit | A only; company-local uniqueness and scoped edit. |
| Employee directory (`Employees`) | `GET /employees` | Query `search?,department?,status?,page?,limit?` | `{items,total,page,pages}`; populated department/designation | A/H company directory; E own record only. Limit 1–100; input/ID validation. |
| Employee creation (`Employees`) | `POST /employees` | Employee fields + temporary `password` | 201 Employee; real hashed User login linked both ways, company ownership and audit | H only; validated company department/designation, globally unique email and company-local code. |
| Employee 360 / self profile (`Employee360`, `Profile`) | `GET /employees/:id` | Scoped employee ID | `{employee,attendance,leaves}`; real recent attendance and populated leave types | A/H company member; E self only; missing/foreign ID 404. |
| Employee edit (`Employees`) | `PATCH /employees/:id` | Strict full employee fields | Updated Employee; matching User name/email updates, audit; login-email changes revoke sessions/reset links; employment exit deactivates login and queues biometric deletion | H only for full edit; exited status requires exitDate and valid employment interval. |
| Self contact edit (`Profile`) | `PATCH /employees/:id` | `{phone,address}` only | Updated own Employee + audit | E self only; no salary, status, department, role or peer edits. |
| Employee CSV export (native link) | `GET /employees/export` | Cookie | CSV stream from actual Employee records | H only, scoped; formula-bearing spreadsheet cells escaped. |
| Employee CSV validation/import (`Csv`) | `POST /employees/import` | `{csv,dryRun,password?}` | Dry-run `{rows,valid,errors}` or actual `{imported,errors}`; row/field/reason diagnostics | H only; max500 rows, bounded CSV, company references/codes and global login email checked; real import atomic and requires temporary password. |

Employee removal is represented by the existing audited exit/deactivation workflow; the UI does not expose a hard-delete action. Historical attendance, leave and payroll references are retained. There is no unimplemented frontend `DELETE /employees` call to replace with a fabricated endpoint.

### Attendance, biometrics, leave and payroll

| Frontend feature / source | Method and endpoint | Request | Successful response / persistence | Access and failure boundaries |
| --- | --- | --- | --- | --- |
| Attendance board (`Attendance`) | `GET /attendance` | `start?,end?,department?` | Real saved attendance plus eligible derived absence/approved-leave rows; employee name/code/department | A/H company scope; E self. Derived absence comes from employment/calendar/leave, never random data. |
| Ordinary attendance (`CheckButtons`) | `POST /attendance/check-in`, `POST /attendance/check-out` | Empty body | Saved Attendance with server timestamps, shift date, policy snapshot, verification metadata, computed hours/status and audit | H/E linked employee; duplicate/stale/out-of-order attendance, payroll locks, workday/employment/leave policies checked transactionally. No client timestamps or verified flags. |
| Attendance analytics and five charts (`AttendanceAnalytics`) | `GET /attendance/analytics` | `start?,end?,department?,employee?,page?,limit?` | `{filters,generatedAt,summary,today,weekly,monthly,departments,distribution,history,calendar,historyTotal,page,limit,departmentOptions,employees,empty}` from real Mongo aggregates | A/H authorized company filters; E forced self scope. Bounded reporting period/pagination and explicit company-filtered joins. No-store; UI polls and refreshes on attendance events. |
| Biometric availability/enrollment (`useBiometricStatus`) | `GET /biometrics/status` | None | Configured/model/consent/retention/liveness-limitation/enrollment view | Auth company account; production HTTPS required; no encryption key, embedding or encrypted template returned. |
| Camera challenge (`BiometricEnrollment`, `FaceVerification`) | `POST /biometrics/challenges` | `{purpose:'enroll'|'check-in'|'check-out',consent?,consentVersion?}` | 201 `{challengeId,expiresAt,provider,capture,livenessSupported:false}`; real account/company/purpose-bound one-use challenge and audit | H/E linked active employee; rate/failure limits. Enrollment requires explicit current consent; attendance requires current enrollment. Missing local files/key/runtime 503. |
| Face enrollment (`BiometricEnrollment`) | `POST /biometrics/enrollment` | `{challengeId,samples:[three bounded base64 JPEGs]}` | 201 enrollment view after actual local detection, five-point alignment, 128-D SFace embeddings, duplicate/quality/consistency checks; AES-GCM encrypted template + audit | Same account/company/current consent and fresh unused challenge; exactly one face per sample; client embeddings/approval flags rejected. |
| Face attendance (`FaceVerification`) | `POST /biometrics/attendance` | `{challengeId,action,location:{latitude,longitude,accuracy},samples:[three JPEGs]}` | Actual local identity match then atomically saved Attendance, same business rules as ordinary attendance; Mongo-backed charts refresh | H/E self, company scoped; geofence/accuracy and active template checked; mismatch 422 with no attendance. No reliable liveness or replay resistance is claimed. |
| Withdraw/delete own enrollment (`BiometricEnrollment`) | `DELETE /biometrics/enrollment` | None | `{deleted,status,message}`; local encrypted template deleted and challenges cancelled; audit retained | Self; does not require decryption key to delete. Legacy cloud metadata returns202 cleanup-required rather than falsely claiming external deletion. |
| Staff enrollment deletion (supported API) | `DELETE /biometrics/enrollment/:employee` | Scoped employee ID | Same deletion result | A/H may revoke a company member; E cannot revoke a peer. This staff API exists but current user-facing enrollment page calls only the self endpoint. |
| Correction list (`Attendance`) | `GET /corrections` | None | Correction array with employee name/code | A/H company; E self. |
| Request correction (`Attendance`) | `POST /corrections` | `{date,checkIn,checkOut,reason}`; UI converts UTC datetime-local fields to ISO Z strings | 201 pending Correction + audit | E only; completed eligible shift, employment/working-date checks, one pending request per date. |
| Decide correction (`Decision`) | `PATCH /corrections/:id` | `{status:'approved'|'rejected',comment}` | Updated Correction; approved case updates actual Attendance with HR-correction method, audit and recipient notification | H only; cannot approve own correction, reject repeat decision/finalized payroll/approved leave conflicts. |
| Leave types (`Catalog`, `Leaves`) | `GET /leave-types` | None | LeaveType array | All; company scoped. |
| Edit leave type (`Catalog`) | `POST /leave-types`, `PUT /leave-types/:id` | `{name,quota,unpaid}` | 201/200 real LeaveType + audit | A only; quota integer and company-local uniqueness. |
| Public holidays (`Catalog`) | `GET /holidays` | None | Holiday array | A/H, scoped. |
| Edit holiday (`Catalog`) | `POST /holidays`, `PUT /holidays/:id` | `{name,date}` | 201/200 Holiday + audit | A only; valid ISO date/company-local uniqueness. |
| Leave balances (`Leaves`, dashboard) | `GET /leave/balance` | `year?` | Leave types with `{used,pending,remaining}` from real pending/approved days | H/E linked employee, self only. |
| Leave history (`Leaves`) | `GET /leave` | None | Populated Leave array with real employee/type/status | A/H company; E self. |
| Apply leave (`Leaves`) | `POST /leave` | `{type,start,end,reason}` | 201 persisted pending Leave, real working-day list, quota snapshot and audit | H/E self; employment dates, no overlap, quota reservation, same-year rule and payroll locks. |
| Approve/reject/cancel leave (`Decision`) | `PATCH /leave/:id` | `{status:'approved'|'rejected'|'cancelled',comment}` | Updated Leave + audit + recipient Notification | H approves/rejects another employee; H/E cancels own pending/approved request; no self-approval, repeat decisions, attendance conflict or finalized-payroll changes. |
| Payroll runs/payslips (`Payroll`) | `GET /payroll` | None | Real Payroll array; each has `month,status,slips,...` | A/H company; E only finalized runs with only own slip. |
| Generate/regenerate draft (`Payroll`) | `POST /payroll` | `{month:'YYYY-MM'}` | 201 real draft Payroll/slips + audit, derived from employment/attendance/leave/tax rules | H only; finalized month locked. |
| Finalize draft (`Payroll`) | `POST /payroll/:id/finalize` | Empty | Finalized Payroll + audit and notifications to actual slip users | A only; server regenerates/compares inputs and rejects stale draft, then permanently locks month. UI also asks for month confirmation. |
| Payslip PDF (native link) | `GET /payroll/:id/payslip/:employee` | Cookie | Actual scoped finalized payslip PDF stream, not JSON | A/H company member; E self only; draft409, missing/foreign404. |

### Dashboards, communication, audit and optional AI

| Frontend feature / source | Method and endpoint | Request | Successful response / persistence | Access and failure boundaries |
| --- | --- | --- | --- | --- |
| Admin/HR/Employee dashboard (`Dashboard`) | `GET /dashboard` | `start?,end?,department?` | Real attendance/headcount/salary/payroll/leave aggregations and applicable self-service values | Company scoped; E self and no company salary/demographic grouping; department-filter aggregate cast defect identified above. |
| Announcement list (`Announcements`, compact dashboard) | `GET /announcements` | None | Real Announcement array with actor name | All, company scoped. |
| Publish announcement (`Announcements`) | `POST /announcements` | `{title,body}` | 201 Announcement with actor + audit | A/H only, bounded strict body. |
| Notifications (`Notifications`) | `GET /notifications` | None | Actual recipient-specific Notification array | All, current recipient + company only. |
| Mark read (`Notifications`) | `PATCH /notifications/:id` | Empty | Actual notification with `read:true` | Recipient + company enforced; cannot mark peer/foreign notification. |
| Audit logs (`Audit`, compact Admin dashboard) | `GET /audit` | None | Actual AuditLog array with actor name/role | A only, company scoped; password/token/biometric values redacted on audited business writes. |
| AI availability (`Dashboard`, `Leaves`, `Assistant`) | `GET /ai/status` | None | `{configured,features,...}`; missing key includes `AI_NOT_CONFIGURED` notice | All, separate from AI request quota; no credential values. |
| Optional chat/summary/smart-leave (`Assistant`, `Dashboard`, `Leaves`) | `POST /ai/chat` | `{mode,message,filters?}` | Real configured provider result/tool outputs; smart leave returns a draft for explicit user confirmation | All with role-scoped read-only tools, strict body and request quota. Missing key503 `AI_NOT_CONFIGURED`; ordinary forms/core APIs remain available. No fake AI response. |

## Non-endpoint pages and boundaries

`/attendance-kiosk` redirects to login; it is not an anonymous face-attendance API. The unmounted `FaceScanner`/camera-preview components do not submit attendance and are not evidence of identity verification. Active face enrollment and attendance use `LocalFaceCapture` and the authenticated `/biometrics` flow described above.

The active frontend is `HCM-frontend`; `hcm-app` is a preserved earlier checkout. This audit does not silently change saved repository selection or treat that historical checkout as the app being tested.

## Exact login-error cause and fix

The original login component executed `GET /api/setup` as soon as it mounted. In the original API client, a JSON parse failure was replaced by `{message:"The service returned an invalid response."}`; that message was thrown only when the response also had a non-success HTTP status. `Auth.jsx` caught the failure and displayed it before a login attempt. Therefore the reported immediate text is the specific combination of **an automatic setup request and a non-JSON, non-2xx API/proxy response**. It is not evidence that an expected JSON 401 session check was an application failure. A misleading HTML 200 response was another invalid-shape path: the old client returned it as a message object rather than rejecting the protocol mismatch.

At this audit’s initial runtime check, frontend/backend health requests returned JSON 200 and unauthenticated `/auth/me` returned normal JSON 401. The audit runner then reproduced the exact reported message with the **original production frontend build**: it temporarily stopped only the owned backend watcher, opened `/login` in Chromium without submitting credentials, observed the automatic `/api/setup` request return **HTTP 500 with no Content-Type**, and saw **“The service returned an invalid response.”** The normal backend was restored immediately afterward. The reproduction script is `/workspace/onboarding/browser/audit-login-baseline.cjs`.

This confirms the original error mechanism rather than merely hiding its output: a failed Next rewrite produced a non-JSON server error during initialization, and the client turned that protocol failure into the confusing login message. The historical deployment’s original hostname/configuration was not available, so this report does not invent a specific remote outage or environment value. Accepting malformed HTML 200 responses was an additional protocol bug fixed separately.

The fix preserves genuine errors. `lib/api.js` validates response format even on HTTP200, preserves structured status/code and reports network failures clearly. A runtime App Router API proxy replaces build-time rewrites so the currently configured backend origin is used after deployment. It normalizes origins with or without an `/api` suffix, returns structured JSON errors for unreachable/misconfigured/non-API upstreams, and forwards real cookies and JSON/PDF/CSV responses. Workspace session restoration redirects only a401; other failures remain visible with Retry instead of becoming a login loop. The auth component treats an expected unauthenticated session as a normal sign-in state.

Frontend files for this correction: `lib/api.js`, `lib/server-api-proxy.js`, `app/api/[...path]/route.js`, `next.config.ts`, `.env.example`, `components/Auth.jsx`, and `components/Workspace.jsx`. Auth-page additions and their backend endpoints are listed separately in the integration matrix.

## Registration and recovery integration after changes

The new `/register` page calls `POST /auth/register`. `publicAuthRoutes.js` creates a distinct Company, its company-linked Admin account, standard leave-policy configuration and audit in one real MongoDB transaction. It uses the existing `signIn` function to set the HttpOnly cookie and return the Admin user view with HTTP 201; the frontend routes that actual user to `/admin/dashboard`. The login page includes the visible **Don't have an account? Register your company** link to `/register`. Existing first-run `/setup` remains compatible.

`POST /auth/forgot-password` validates the email and verifies a real Nodemailer SMTP transport. If an active account exists, it stores only a SHA-256 token digest with a 15-minute expiry and sends the actual 64-character random token only in the reset email. The public 202 response is generic. Missing configuration or unavailable delivery returns 503 and never claims an email was sent. A failed send removes the un-delivered token. `POST /auth/reset-password` consumes a delivered, unexpired token atomically, verifies the account/token version, updates the password, clears forced rotation, revokes old sessions and establishes the new session. The reset page obtains the email-link token; no token/hash is listed through ordinary account or business APIs.

Required backend delivery settings are `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` (default 587), `SMTP_SECURE`, optional paired `SMTP_USER`/`SMTP_PASSWORD`, and trusted `AUTH_APP_URL`. Production reset links must use HTTPS and SMTP uses TLS with certificate verification. Real delivery to an external mailbox remains configuration-dependent; automated coverage uses an actual isolated loopback SMTP protocol receiver, not a production mailbox or a fake business API. Company registration/login and all ordinary workflows remain available without SMTP.

The focused authentication suite passed 9/9 checks against isolated MongoDB and the loopback SMTP fixture after the login-email-change recovery hardening. The browser also completed the actual forgot/reset flow and confirmed the old session was revoked. These fixtures do not certify delivery to a real external mailbox.

## HCM Lite favicon

`HCM-frontend/app/icon.svg` supplies the custom scalable HCM Lite monogram: a cyan H, light connector and rose accent over a charcoal rounded square. `app/favicon.ico` replaces the stock Next.js file with matching 16, 32, 48 and 64px variants. App Router’s icon-file conventions generate the icon links, avoiding conflicting hardcoded legacy references.

`app/layout.jsx` now defines **HCM Lite | People & Payroll** as the default title, `%s | HCM Lite` for page titles and `applicationName: HCM Lite`. Asset validation decoded all four ICO sizes with Pillow and parsed the SVG 32×32 view box. Chromium verified the actual production ICO/SVG bytes and generated icon/title metadata. A separate Next development server on port 3002 also returned HTTP 200 for both custom icon routes, byte-for-byte equal to the source files. See `HCM-frontend/docs/favicon.md`.

## Environment configuration

The browser calls same-origin `/api` for JSON, CSV and PDF so it never needs a server’s loopback address and keeps HttpOnly cookie authentication. The runtime Next proxy reads server-side `API_INTERNAL_URL` and accepts an origin or an origin ending in `/api`. When it is unset, `NEXT_PUBLIC_API_URL` is accepted as a compatibility alias; it does not switch the browser to cross-origin credential requests. Local defaults target `http://127.0.0.1:4000` with Express `PORT=4000`. Thus the user’s local `NEXT_PUBLIC_API_URL=http://localhost:4000/api` can be normalized without generating `/api/api`.

Use a reachable Express origin for `API_INTERNAL_URL` when Next and Express are deployed separately. Updating the runtime environment must reach/restart the Next server as appropriate. A backend outage must remain an actionable JSON gateway error; it must not be rendered as an unexplained JSON parse failure or a fake successful response.

Backend secrets (`MONGODB_URI`, `JWT_SECRET`, `BIOMETRIC_TEMPLATE_KEY`, mail credentials) must not use `NEXT_PUBLIC_` names. Local recognition runs without AWS or external biometric API credentials. `AI_API_KEY` is optional and only enables hosted LLM features. See `.env.example` and [face-attendance.md](face-attendance.md) for actual model installation and limitations.

## Tests actually performed

Source review mapped all active calls above and checked MongoDB operations, input validation, response fields and role/company constraints. All business workflow tests used real Express APIs and isolated MongoDB collections. Existing regression coverage includes local model inference, payroll rules, tenant isolation, attendance clocks/analytics and missing-provider fallback.

| Verification | Actual result / boundary |
| --- | --- |
| Final full backend `npm test` run | **83/83 passed**, zero failed or skipped, including the login-email-change recovery regression (28.2 seconds). |
| Post-hardening authentication suite | **9/9 passed** against isolated MongoDB plus an actual loopback SMTP protocol receiver; email changes revoke links/sessions issued to the former address. |
| Dashboard/attendance focused regressions | **8/8 passed**: ObjectId filter casting, real counts, company-scoped labels, saved history after calendar changes, business dates/overnight shifts and end-date snapshot populations. |
| Frontend protocol tests | **7/7 passed** with isolated local HTTP transport fixtures: runtime origin/API suffix, structured errors, cookies and JSON/PDF/CSV response behavior. These fixtures are not successful HCM business API stubs. |
| Frontend lint | Passed. |
| Frontend production build | Passed: 52 static pages plus the dynamic API proxy route, including registration, recovery and the custom icon. |
| Original login-error reproduction | Original production frontend, owned backend temporarily stopped, `/login` before submission: automatic `/api/setup` returned 500 without Content-Type and displayed the exact reported message. Backend restored immediately. |
| Full real-browser workflow | All 11 Chromium groups below passed using actual backend APIs and the isolated MongoDB/SMTP fixtures. |
| Development icon routes | Separate Next dev server: HTTP 200 and source-identical favicon/SVG bytes. Production icon bytes and generated head metadata also passed. |

The focused backend 9-check authentication and 8-check dashboard results are subsets of the final 83-check backend suite, not additional checks to add to that total. The 7-check protocol suite is a separate frontend verification.

The full browser runner is `/workspace/onboarding/browser/full-api-audit.cjs`. Its passing workflow groups were:

1. Unauthenticated login displays normally without an automatic error; invalid credentials show a clear failure.
2. `/register` creates a real Company/Admin, establishes the cookie session and opens the Admin dashboard.
3. Admin activates HR, HR rotates the temporary password, creates/lists an employee and downloads actual CSV data.
4. Employee rotates the temporary password, opens the dashboard, records real attendance and sees MongoDB-backed charts.
5. Leave submission, notifications, role boundaries and employee-only analytics use actual scoped records.
6. HR generates payroll, Admin finalizes it and an authorized user downloads the actual payslip PDF.
7. A second company registers successfully and company isolation holds.
8. The actual SMTP receiver obtains a reset email; the forgot/reset browser flow completes and revokes the old session.
9. Custom ICO/SVG bytes, head metadata/title and 375px layout render correctly.
10. A real backend outage produces structured 502 JSON and visible login/dashboard Retry states, without an erroneous dashboard-to-login redirect; restoring the API restores the workflow.
11. No hydration or page-runtime errors were observed.

The browser database `hcm_browser_api_audit` was dropped after verification. The normal frontend proxy was restored to the API on port 4000, using the existing local `hcm_lite` database. Both health endpoints returned 200 JSON; unauthenticated `/auth/me` returned expected 401 JSON. No browser fixture users or business records were left in the application database. External production SMTP delivery remains unconfigured and untested; local protocol delivery is the test evidence.

The legacy lateness-percentage expression was clarified and tested with actual counts (1/6 gives 16.67%); its previous arithmetic was already correct and is not reported as a confirmed calculation defect.

## Changed-file groups and remaining configuration

The login/proxy files are enumerated above. Registration and recovery add `src/routes/publicAuthRoutes.js`, `src/services/authRecoveryService.js` and the PasswordResetToken model, wire the public router in `src/routes/index.js`, document backend SMTP settings and add `tests/auth-registration-recovery.test.js`. Frontend auth changes include the register page, forgot-password form and reset-password page/client component. Dashboard fixes are isolated to `src/services/dashboardService.js`, `src/services/attendanceService.js` and `tests/dashboard-integration-regressions.test.js`. Favicon files and metadata are listed in their dedicated section. Frontend protocol tests and their package script, `.env.example`/README configuration notes, `docs/favicon.md` and this audit report complete the test/documentation changes.

Required deployment configuration is a reachable MongoDB replica set, a stable strong backend JWT secret, the correct frontend-server `API_INTERNAL_URL`, trusted frontend origins in backend `FRONTEND_URL`, HTTPS/correct proxy trust in production, and local model/encryption-key installation if face attendance is enabled. These existing requirements do not become public frontend secrets.

Password-recovery delivery additionally needs real SMTP configuration and the actual trusted `AUTH_APP_URL`. SMTP is optional for core registration/login/attendance/payroll, but a missing or unreachable mail server must remain an explicit recovery error. External real-mailbox delivery is not certified by the loopback SMTP fixture. Hosted AI remains optional. The local YuNet/SFace system still does not supply robust liveness/PAD; this audit does not change that accuracy/security boundary.

No Git history rewrite, commit or push is made for this audit request without a new explicit instruction. The previously pushed local-face implementation remains the baseline.
