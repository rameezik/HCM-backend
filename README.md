# HCM Lite API

Node.js 24.19, Express 5, MongoDB 8 replica set and Mongoose. The paired UI is `rameezik/HCM-frontend` at `/workspace/HCM-frontend` (Next.js16 / React19 / Tailwind4 / JavaScript + JSX).

## Run in this cloud environment

The setup scripts live in `/workspace/onboarding`. Run `bash /workspace/onboarding/start.sh` to start the local MongoDB replica set, API and frontend. The default development database is `hcm_lite`; it starts empty. No business records or default accounts are seeded. Use the frontend first-run setup to enter a company name and create the Admin. Admin creates departments/designations and HR; HR registers employees with a temporary password that must be changed on sign-in. Optional: Admin can promote an existing employee login to HR to enable HR self-service.

For another machine (Node24.19 and a MongoDB replica set required):

```sh
npm ci
cp .env.example .env
# Set JWT_SECRET to a securely generated value and set MONGODB_URI.
npm start
```

Never commit `.env`. Production deployment supplies a strong `JWT_SECRET`, a MongoDB replica-set URI, an exact frontend origin in `FRONTEND_URL`, and `NODE_ENV=production`. HTTPS is required for the secure session cookie in production. The API listens on port4000 by default. `GET /api/health` checks database connectivity. `GET /api/setup` reports first-run status. The frontend proxies `/api` to Express; it never connects to MongoDB.

## Workflow and access

- Admin: first-run company/settings, departments/designations/leave types/holidays, HR logins, reset/deactivate HR and Employee accounts, global records, payroll finalization and immutable audit view.
- HR: employee registration/update and salary, CSV dry-run/import/export, attendance corrections and leave approvals, monthly payroll drafts, HR analytics, announcements. Cannot finalize payroll or alter company settings.
- Employee: own profile phone/address, server-time attendance, correction requests, leave/cancellation/balances, own finalized PDF payslips, personal metrics and notifications. Every API and AI tool enforces role and row scope.
- All users: change password, logout, announcements, notifications and scoped AI/policy questions. Sessions are HttpOnly JWT cookies, revoked on logout/password change/reset/deactivation. Temporary passwords must be changed before using data endpoints.

`src/models` defines the schema. `src/services` holds calendars, attendance, leave balances, payroll, analytics and AI. `src/routes` validates inputs and authorizes mutations. Atomic workflows use MongoDB transactions; a standalone MongoDB server is insufficient. Audits are written in the same transaction as business changes. Employee document version writes serialize competing leave reservations and attendance decisions.

## Calendar and payroll rules

Calendar dates and office hours use UTC, clearly shown in the UI. Defaults:09:00 start,15min grace,half-day under5h,Sat/Sun weekend; Annual14,Sick8,Casual10,Unpaid unlimited. New attendance retains a policy snapshot. Leave stores its counted working dates and excludes holidays/weekends; pending requests reserve quota, overlap/balance conflicts return422. Cross-year leave must be submitted as separate requests. HR cannot approve their own request. Corrections and leave cannot alter a finalized month.

Gross=basic×1.5 (HRA40%,medical10%). Daily gross is divided by working days; joiner/leaver ineligibility, absent days, unpaid days and half of half-days are deducted. Missing checkout counts as attendance as specified by the brief. Tax uses the illustrative progressive annual bands from the PDF, divided by12 and prorated to eligible days, capped at payable earnings. Amounts are shown in PKR. HR may regenerate a draft. Admin finalization rejects a stale draft if inputs changed; finalized payroll is immutable. Finalizing a month closes attendance/leave changes for that month. Review before locking.

CSV headers: `code,name,email,department,designation,joinDate,exitDate,status,gender,basic,phone,address`. Department/designation columns use database IDs shown in organization lists. Optional columns may be omitted; dates are ISO. Dry runs return row/field/reason without writing. Imports are all-or-nothing. CSV export escapes formula-bearing text.

## AI configuration

Set `AI_API_KEY` securely in environment settings. Defaults target Groq's OpenAI-compatible API (`AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=llama-3.3-70b-versatile`); another HTTPS tool-calling provider can be configured with those variables. Permit its exact hostname in network settings. Node24's `--use-env-proxy` uses the platform HTTPS proxy and injected credentials. The key remains on the backend.

`POST /api/ai/chat` accepts `mode: chat|summary|smart-leave`, `message`, and optional `filters`. Seven read-only tools reuse scoped services. Summary uses current server KPI JSON. Smart leave validates output, retries invalid JSON once and requires human confirmation. Calls have a15s cancellation timeout,20/user/hour rate limit and `ai_logs` records. No key/provider failure produces a friendly error; regular forms remain functional. Hosted model outputs, tool-selection behavior, live smart-leave date understanding and provider timeout behavior are **not verified without a provider key**. No fake AI response is used.

## Verification

```sh
npm test
```

Tests run against a real replica set (default local `127.0.0.1:27017`, or `TEST_MONGODB_URI`). Each run creates a unique `hcm_test_*` database and drops only that database. Assertions cover ISO calendars/holidays, grace and half-day rules, all tax boundaries, proration/deductions, bootstrap/auth/forced rotation, role boundaries and peer isolation, attendance/corrections, leave quotas/overlap/cancellation/approval, valid and invalid CSV, database-derived analytics, stale-draft rejection, finalization/locking, real PDF bytes, notifications/audit, missing-key fallback and session revocation. Test fixtures never seed the development database.

Browser smoke instructions and evidence are in `/workspace/onboarding/browser`; they exercise the production Next.js app and real Express/MongoDB using a separate `hcm_browser_test` database, cleared afterward. See `/workspace/onboarding/requirements.md` and `verification.md` for the requirements checklist and actual executed outcomes.

## Not included or not verified

Optional mobile/camera/face/geofence validation, liveness, risk/anomaly/late-penalty/PWA bonuses are not implemented. Live hosted AI requires a key and remains unverified. Local commits are created for review. Public hosting, LMS submission and pushes have not been performed. This is a development environment, not a claim of a production security audit.
