# Public attendance kiosk

The public `/attendance-kiosk` screen in the frontend uses dedicated company-paired device access. Employees do not sign in to scan. A kiosk credential authorizes only kiosk operations; it cannot authenticate `/auth/me`, employee profiles, payroll or other portal APIs.

Recognition remains genuine local CPU inference: OpenCV YuNet detects exactly one face and aligns landmarks; SFace produces 128-dimensional embeddings. The backend independently compares all three captured samples against encrypted, consented enrollment templates in the paired company. A detected face alone never records attendance. There are no cloud biometric API calls or API keys. Model licenses, pinned files and SHA-256 hashes remain in [the local inference report](face-attendance.md) and `models/licenses/`.

## Install and configure

Backend, using Node 24 and Python 3.10–3.13 with `venv`:

```bash
cd HCM-backend
npm ci
npm run setup:face
npm run setup:env
npm start
```

`setup:face` installs the pinned OpenCV/NumPy CPU runtime, downloads the two SHA-256-verified ONNX models, and loads both models as an actual readiness check. `setup:env` is a local-development helper that creates or preserves signing/encryption keys without printing them; it also works when an example env file is absent. It does not silently replace a valid existing encryption key. Supply a reachable MongoDB replica-set URI before starting. The included Dockerfile installs Node, Python, runtime dependencies and real model files for Render; configure deployment secrets through Render's environment settings instead of generating production keys in a build.

Required backend runtime configuration:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Real MongoDB replica-set/Atlas connection used by the portal and kiosk |
| `JWT_SECRET` | Stable secret of at least 32 random characters for portal sessions |
| `BIOMETRIC_TEMPLATE_KEY` | Stable base64 encoding of 32 random bytes for AES-256-GCM templates; backend only |
| `FRONTEND_URL` | Trusted frontend origin; explicit comma-separated origins when needed |
| `TRUST_PROXY` | Actual trusted TLS reverse proxies; configure correctly for production HTTPS |

Optional local inference settings:

| Variable | Default / supported values |
| --- | --- |
| `BIOMETRIC_MODEL_DIR` | Backend `models/local-face` |
| `BIOMETRIC_PYTHON_PATH` | Backend `.local-face-venv/bin/python` |
| `KIOSK_MATCH_THRESHOLD` | Cosine similarity `0.55`; range `0.55`–`0.99` |
| `KIOSK_MATCH_MARGIN` | Best-versus-second-best cosine margin `0.08`; range `0.05`–`0.5` |
| `KIOSK_SCAN_COOLDOWN_SECONDS` | Per-person cooldown `30` seconds; integer range `5`–`300` |
| `BIOMETRIC_RETENTION_DAYS` | Server retention cap, default `365`; stricter company policy applies |

The public identification threshold is deliberately stricter than the private one-to-one verification default. Do not lower a threshold merely to make a particular photo pass. Thresholds and margins need validation with the intended cameras and workforce; these defaults are not an accuracy certification. Keep every secret out of frontend environment variables, source control and browser code. Hosted LLM AI remains optional and unrelated to attendance recognition.

Use the existing same-origin Next.js API proxy and frontend server variable `API_INTERNAL_URL` pointing to the backend. Pairing credentials remain in an HttpOnly cookie; do not copy them into localStorage or JavaScript configuration.

## Admin setup and employee enrollment

1. In Company Settings, configure the office latitude, longitude and attendance radius.
2. Upload a clear current employee profile photo. This stores an ordinary authorized avatar; uploading it does not opt the person into biometric attendance.
3. Open Admin → Attendance kiosks, create a labeled device and obtain its one-time pairing code. It expires after ten minutes and is shown once.
4. Open the public kiosk on the intended device and pair it using that code. Pairing establishes a dedicated `hcm_kiosk` cookie for seven days. Its random credential is hashed in MongoDB, scoped to the company and revocable by Admin.
5. Admin issues a one-use enrollment code for an active employee with a stored photo and active linked account. It expires after fifteen minutes. The grant snapshots the account session version and profile-photo update time.
6. At the public kiosk, the employee enters that enrollment code, reads the consent notice, explicitly consents and captures three camera samples. The backend must match the live samples to the stored profile photo before creating/replacing the encrypted template and enabling kiosk identification.

A failed capture permits a new camera challenge using the same unexpired code, up to three attempts, on the first claiming kiosk only. Successful enrollment consumes the code once. Admin reissuing access revokes outstanding codes. Changed photos/accounts invalidate stale grants; no public gallery or employee roster is exposed.

Existing private enrollments are not automatically enrolled into public identification. Public recognition requires `kioskEnabled`, the current kiosk consent version and a photo timestamp matching the enrollment snapshot. Private deletion/re-enrollment clears public opt-in; changing or deleting the profile photo makes the old public snapshot ineligible until a fresh authorized enrollment.

## Scan and persistence

Select check-in or check-out and capture the face. Every attempt uses an expiring, action-bound, single-use challenge tied to the paired company/device. The backend performs model inference and confidence/margin checks, rechecks active employment/account/consent/photo state inside the attendance transaction, and calls the same attendance writer used by the portal.

Unknown, ambiguous, unenrolled and other-company faces return **“Unregistered profile”** without an attendance write or employee account creation. Successful writes use server timestamps and the existing company timezone, employment, open-shift, duplicate, leave and payroll-lock rules. Check-out requires an open check-in. The normal employee, HR and Admin attendance/analytics APIs immediately read those same MongoDB records.

A per-person cooldown protects against repeated frames and concurrent scans. Camera requests are limited per device, and five failed scans within one minute block further challenges and verification requests, including already-created challenges. Grant retries are independently bounded. Server-side write locks prevent revoked devices, used challenges or changed enrollments from committing a stale scan.

The device stores a server-owned office-coordinate snapshot; clients cannot provide arbitrary GPS fields. The ordinary attendance writer checks that snapshot against current office policy and records `locationSource: paired-kiosk`. Re-pair after changing office location when the previous snapshot is no longer eligible.

## API contracts

Admin-only, authenticated company routes:

| Method/path | Body/result |
| --- | --- |
| `GET /api/kiosk-management/devices` | Safe device metadata array, no credentials |
| `POST /api/kiosk-management/devices` | `{label}` → device metadata, pairing token and expiry, shown once |
| `DELETE /api/kiosk-management/devices/:id` | Revoke the device and pending challenges |
| `POST /api/kiosk-management/enrollment-grants` | `{employee}` → one-use code, expiry and Admin-visible employee metadata |

Public device routes, without an employee session:

| Method/path | Body/result |
| --- | --- |
| `GET /api/kiosk/status` | Unpaired state or paired device/configuration/consent readiness; no gallery |
| `POST /api/kiosk/pair` | `{pairingToken}` → dedicated HttpOnly device cookie |
| `POST /api/kiosk/unpair` | Revoke the credential and clear its cookie |
| `POST /api/kiosk/challenges` | `{purpose: enroll | check-in | check-out}` → expiring nonce and capture limits |
| `POST /api/kiosk/enroll` | `{challengeId,enrollmentCode,consent:true,consentVersion,samples}` |
| `POST /api/kiosk/attendance` | `{challengeId,action: check-in | check-out,samples}` |

Samples are exactly three bounded JPEG camera captures. Client-provided employee IDs, timestamps, embeddings, verification-success flags, arbitrary location or device ownership cannot substitute for server checks.

## Security boundaries and limitations

- HTTPS is required in production. Configure the exact trusted proxy/origins; localhost HTTP is development only.
- Pairing uses a 256-bit random single-use secret. The separate seven-day device credential is also random, hashed in MongoDB, HttpOnly, SameSite Strict and Secure in production. Admin revoke and public unpair invalidate it on the server.
- A paired kiosk is a trusted physical installation. Its office snapshot is not GPS attestation: a copied/stolen device cookie used elsewhere cannot prove the scanner's physical location. Secure the device/browser profile and revoke lost devices.
- YuNet/SFace provides identity matching without robust presentation-attack detection, camera provenance or reliable liveness. A photograph, replay or injected video may defeat matching. Do not use this as sole proof of physical presence or as a high-assurance authentication factor.
- Enrollment is optional and requires explicit informed consent. Portal deletion or Admin revocation removes/disables the template; expiry/deactivation/exit follows existing retention cleanup. Raw camera frames are not persisted. Profile photos and backups have separate operator-managed retention/deletion policies.
- Current local gallery capacity is bounded to 1,500 eligible templates per company. Larger galleries fail with a configuration/capacity error instead of silently searching an incomplete list.
- Authorized manual portal attendance and HR/Admin correction remain available without biometric consent or a configured model. Missing model/runtime/encryption configuration reports an error and never creates a simulated recognition success.

## Verification

`tests/kiosk-access.test.js` exercises real MongoDB pairing, hashed credentials, one-time/action/device-bound nonces, grants with three same-device retries, failed-scan limits, revocation/unpairing, production HTTPS and office prerequisites. `tests/password-change-policy.test.js` verifies that normal issued Employee/HR credentials and legacy recommended-password records reach their dashboards immediately, while explicitly enforced changes still protect access until a real password update.

`tests/kiosk-recognition.test.js` performs actual local YuNet/SFace inference with isolated public-domain image fixtures and real MongoDB. The final run results and browser acceptance results must be taken from the completed test output; fixture camera streams do not establish physical-camera or anti-spoofing accuracy.
