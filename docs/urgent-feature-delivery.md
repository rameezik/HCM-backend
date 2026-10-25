# Urgent HCM Lite feature delivery

## Features delivered

- Admin can create employees directly, choose Employee/HR/Admin roles, edit profiles and department assignments, and manage activation/reset access. Temporary credentials require a first-login password change. Existing User/Employee collections and JWT cookies remain in use.
- Admin and HR can create/edit departments and designations, inspect employee counts/members, assign employees and remove unused records. Employee and payroll references prevent unsafe deletion.
- Privileged changes recheck the active Admin under a company transaction lock. Self-demotion/deactivation and loss of the last active Admin are prevented. HR cannot elevate roles or edit privileged staff accounts; role/email changes revoke old sessions/reset links.
- Admin/HR dashboards expose real company employee/department/HR/presence/absence/pending-leave counts and saved attendance. Employee dashboards expose the actual profile/department, face-enrollment link, face attendance, history and leave actions.
- Existing free local YuNet/SFace inference remains genuine: consented encrypted enrollment, identity matching on the backend, server-generated attendance timestamps and working duration. Face status now reports enrollment, office/model readiness and persisted attendance; UI confirmation checks the returned face method/timestamp. Charts continue to use MongoDB data.

## Frontend changes

`components/Workspace.jsx`, `components/CompanyOverview.jsx`, `components/attendance/FaceVerification.jsx`, `config/navigation.js`, `lib/biometrics.js`, and `app/api/[...path]/route.js`.

Navigation exposes Employees, Departments and HR Management. Forms and available actions follow backend permissions. The same-origin runtime proxy is preserved; its Vercel route declares a 90-second maximum duration.

## Backend changes and API contracts

`src/routes/index.js`, `src/services/dashboardService.js`, `src/services/biometricService.js`, `src/app.js`, `src/config/httpConfiguration.js`, deployment files and focused tests.

| Endpoint | Delivered behavior |
| --- | --- |
| `POST /api/employees`; `PATCH /api/employees/:id` | Admin/HR employee management; only Admin assigns privileged roles; linked account state and safe projected account fields returned. |
| `POST /api/users`; `PATCH /api/users/:id` | Admin HR/staff creation, role/activation/reset-access management and last-Admin guards. |
| `GET/POST /api/departments`; `PUT/DELETE /api/departments/:id` | Real company catalog/counts, authorized management, referenced-record deletion protection; members use `GET /api/employees?department=...`. |
| `GET/POST /api/designations`; `PUT/DELETE /api/designations/:id` | Authorized real catalog management and reference-safe deletion. |
| `GET /api/dashboard` | Company summary counts and current attendance from the actual database. |
| `GET /api/biometrics/status` | Actual enrollment/configuration/office readiness and persisted attendance; no embedding/key exposure. |
| Existing enrollment/attendance APIs | Actual local inference and transactional attendance rules retained; failure never becomes a face success. |

Existing authorized Admin business operations now include attendance-correction/leave decisions and payroll preparation/finalization, with the same self-approval, stale-draft and finalized-month safeguards. No conflicting API client or authentication system was introduced.

## Dependencies and deployment configuration

No new npm dependencies were required for this phase. The existing CPU runtime remains `opencv-python-headless==4.13.0.92` and `numpy==2.2.6`, with SHA-256-verified YuNet/SFace ONNX files. The Dockerfile installs Node 24, Python 3/venv, CA certificates and `libgomp1`; model loading is checked during image construction. `scripts/setup-local-face.sh` now gives actionable Python/venv/version failures.

Use the supplied `Dockerfile` and `render.yaml` for the Render backend. Model files and the Python venv are installed during the build rather than assumed to exist in Git. Runtime secrets are excluded from the image. See [render-local-face.md](render-local-face.md) for deployment commands.

- Vercel: `API_INTERNAL_URL=https://<your-render-service>`; the browser continues to call same-origin `/api`.
- Render: `NODE_ENV=production`, reachable Atlas `MONGODB_URI`, stable strong `JWT_SECRET`, exact HTTPS Vercel origin in `FRONTEND_URL`, and `TRUST_PROXY=1` for the documented single Render ingress. Numeric hop values are now parsed correctly; origin whitespace/trailing slashes are normalized.
- Face attendance: stable backend-only `BIOMETRIC_TEMPLATE_KEY` containing base64 of exactly 32 random bytes, `BIOMETRIC_TEMPLATE_KEY_ID=v1`, default cosine threshold 0.363 and retention 365 days. Configure office coordinates/radius/timezone in company settings. Never generate a replacement template key at every restart.
- `AI_API_KEY` remains optional. SMTP is needed only for external email recovery, not account creation or normal attendance.

## Verification

The final full backend suite passed **98/98**, zero failed/skipped. The frontend protocol suite passed **7/7**, lint passed and the production build passed with 52 static pages and the dynamic API proxy. Focused account/department tests use actual isolated MongoDB/API operations, including concurrent Admin changes, role boundaries and reference-safe deletion.

Newer upstream commits were merged without rewriting history. Their removal of `.env.example` exposed a fresh-install setup failure; local setup now uses non-secret defaults when that optional template is absent, generates private keys and preserves them on repeat setup. All three focused environment checks passed after the merge, and both normal application health endpoints remained connected to MongoDB.

The real Chromium runner `/workspace/onboarding/browser/urgent-features.cjs` passed every acceptance workflow: Admin created the department, designation, HR login and employee/account/assignment through visible frontend forms; HR and Employee logged in with their own credentials and completed forced password rotation; each reached the correct dashboard. The employee enrolled with consent using actual browser camera/canvas samples and local SFace inference. A real Grace Hopper fixture mismatch returned 422 and created no attendance. The NASA fixture camera then completed face check-in/check-out with server-timestamp UI confirmations, duplicate prevention 409 and saved MongoDB history after refresh. HR saw the saved record; Admin saw actual company counts and charts. Cross-company access and employee privilege requests were rejected, and no browser runtime/hydration errors were observed.

The harness owned a separate child API on 4001 and `hcm_browser_urgent_features`, proved the frontend targeted that child before creating fixtures, and removed the fixture database/process afterward. The normal port 4000 API and application records were untouched.

The actual Docker image also completed 128-D local model inference as non-root UID 1000 with networking disabled: same-person cosine 0.914 and different-person 0.1395 against the default 0.363 threshold. Runtime `.env` and the optional build-CA secret were absent from the image. This verifies the packaged inference runtime, not a live Atlas-connected Vercel/Render deployment.

## Limits

The camera acceptance runner uses a public-domain fixture-video stream through real `getUserMedia`/canvas and the actual model; that is distinct from physical-camera/workforce accuracy or robust liveness/PAD validation. YuNet/SFace does not provide reliable replay/anti-spoofing protection. Raw camera images are processed transiently; encrypted templates retain the existing consent/deletion policy.

No authenticated Vercel/Render deployment was performed from this workspace. Live deployment still requires the actual service URLs, Atlas access, persistent secret configuration and adequate instance resources. The manifest and local image/runtime checks must not be described as proof of an already updated hosted site.
