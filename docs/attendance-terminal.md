# Attendance Terminal

Employees scan their face at `/attendance-terminal` without signing in. The server matches the camera samples against approved employee profile photos in the connected company. A successful check-in saves attendance and shows **Present**. An unknown face shows **Record not found** and creates no attendance or employee record.

## Local installation

Use Node 24, Python 3.10–3.13 and a MongoDB replica set. On Windows, run the backend in WSL or use the supplied Dockerfile.

```bash
cd HCM-backend
npm ci
npm run setup:face
npm run setup:env
npm start
```

Set `MONGODB_URI` to your actual replica-set connection. Keep the existing `JWT_SECRET` and `BIOMETRIC_TEMPLATE_KEY` when upgrading; changing the encryption key makes existing face templates unreadable. The local setup command creates missing development keys without printing them. Set production secrets in your hosting environment.

Required local model files in `models/local-face`:

- `face_detection_yunet_2023mar.onnx`: OpenCV YuNet, MIT license; face detection and alignment landmarks.
- `face_recognition_sface_2021dec.onnx`: OpenCV SFace, Apache 2.0 license; identity embeddings.

`setup:face` installs the pinned OpenCV CPU runtime, verifies the model hashes and loads both models. No AWS credentials, paid APIs or external recognition keys are used. Model licenses and runtime details are in [face-attendance.md](face-attendance.md).

For the frontend:

```bash
cd HCM-frontend
npm ci
npm run build
npm start
```

The frontend server uses `API_INTERNAL_URL=http://127.0.0.1:4000` for a local backend. The browser calls the same-origin `/api` proxy.

## Company setup

1. Configure the office location in Company Settings.
2. Open `/admin/attendance-terminal`. Upload a clear employee photo with one face.
3. Record the employee's permission and select **Enable face attendance**. The backend derives and encrypts the template from that saved photo. No employee enrollment code or separate camera enrollment is needed.
4. Create a terminal link and open it on the attendance device. Employees can then start the camera and scan without an employee account session on the device.
5. Keep **Check in** selected for arrivals. Use **Check out** for departures. A successful scan pauses until the next person; it never automatically toggles a check-in into a check-out.

The shared link can connect more than one browser until its seven-day expiry or Admin revocation. The link grants attendance-terminal access only. It cannot open employee profiles, payroll or other authenticated portal APIs. The secret is carried in the URL fragment, removed after connection and stored in an HttpOnly cookie. Store and share the link only with the intended attendance operators.

Replacing a photo disables the old match until Admin enables the new photo. **Disable face attendance** withdraws terminal access; photo-derived templates are deleted. The employee's profile avatar is a separate record and is removed through the photo controls.

## Recognition and attendance rules

The server detects and aligns exactly one face, computes three local SFace embeddings, and compares them with the connected company's approved templates. It independently checks the linked active account, current photo version, consent, employment, attendance dates, duplicates and payroll locks before writing MongoDB. Dashboards and charts read those saved records.

Missing models, an unreadable encryption key or an invalid camera frame produce a configuration/capture error. These conditions are not reported as an unknown employee. Ordinary login, employee management, manual attendance, leave and payroll continue without face models or an `AI_API_KEY`.

The public identification threshold defaults to `KIOSK_MATCH_THRESHOLD=0.55`, ambiguity margin to `KIOSK_MATCH_MARGIN=0.08`, and per-person scan cooldown to `KIOSK_SCAN_COOLDOWN_SECONDS=30`. Existing variable names remain supported for upgrades. Do not lower thresholds merely to accept a particular photo.

## Limits

Use HTTPS outside localhost. A supervised terminal and its company-configured office location are trusted; the stored office coordinates do not prove where a copied terminal credential is being used. Revoke lost links/devices.

YuNet/SFace performs face matching, without reliable liveness or replay protection. A photograph, video or injected camera stream can defeat it. Test accuracy on the intended cameras and workforce; automated fixture tests do not certify physical-camera accuracy. Authorized manual attendance and HR correction remain available.

The gallery is limited to 1,500 active employee templates per company. Templates are encrypted with AES-256-GCM, expire under the retention policy and are company-scoped. Camera captures are processed in memory and are not saved. Database backups follow the operator's retention policy.

## Connection troubleshooting

The backend uses the machine's DNS settings by default. If your network requires a specific resolver for MongoDB SRV records, explicitly set `MONGODB_DNS_SERVERS` to a comma-separated list of IP addresses. No public or private resolver is forced on every installation.

Run `npm test` in each repository. `tests/profile-photo-terminal.test.js` uses isolated MongoDB records and actual local inference to cover photo activation, public verification, rejected faces, duplicate prevention, photo replacement, deletion, company isolation and missing-model errors. No test employees are inserted into the application's database.
