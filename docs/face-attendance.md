# Local face attendance, analytics and optional AI

## Selected implementation and licenses

Face attendance now uses **OpenCV YuNet detection + SFace identity embeddings**, entirely on the application's own backend CPU. No AWS, paid API, cloud biometric provider or external API key is used by the local biometric path. Ordinary attendance, leave, payroll, authentication and MongoDB dashboards remain independent of model availability.

| Component | Purpose | License/source |
| --- | --- | --- |
| OpenCV Python 4.13.0.92 | Maintained CPU ONNX/DNN runtime, `FaceDetectorYN` and `FaceRecognizerSF` | OpenCV Apache-2.0; package includes third-party notices |
| YuNet `face_detection_yunet_2023mar.onnx` | Face bounding box and five facial landmarks | [MIT, official OpenCV Zoo directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| SFace `face_recognition_sface_2021dec.onnx` | 128-dimensional identity embedding of an aligned face | [Apache-2.0, official OpenCV Zoo directory](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) |
| NumPy 2.2.6 | Numeric arrays and embedding normalization | BSD-3-Clause |

Model licenses and source details are retained under `models/licenses/`. These permissive licenses permit use and modification subject to their notices. The trained weights are established models, not a claim of newly trained weights or certified accuracy. Keep their notices when distributing the application/models.

MediaPipe was considered for detection/landmarks, but it does not establish identity by itself. YuNet provides the five landmarks expected by OpenCV's official SFace `alignCrop` implementation, so using the supported pair avoids a second detector and custom alignment conversion. ONNX files are executed with OpenCV DNN on CPU; a separate ONNX Runtime installation, GPU or browser inference package is unnecessary.

## Exact installation

Requirements: Node.js 24.19 (minimum 24.5), Python 3.10+ with `venv`/pip support, a CPU supported by the OpenCV Python wheel, and a MongoDB replica set. Python 3.11 is supported by the prepared environment. The installer requires Internet access to Python package indexes and the official GitHub model download host; inference after installation requires no Internet access. Reserve disk space for the Python environment and the approximately 37 MiB recognition model.

From the backend repository:

```sh
cd /workspace/HCM-backend
npm ci
bash scripts/setup-local-face.sh
npm run setup:env
# Configure MONGODB_URI for a reachable replica set and FRONTEND_URL for the UI.
npm start
```

From the frontend repository:

```sh
cd /workspace/HCM-frontend
npm ci
npm run dev
# Production validation/start:
# npm run lint && npm run build && npm start
```

`setup-local-face.sh` creates `.local-face-venv`, installs pinned `opencv-python-headless==4.13.0.92` and `numpy==2.2.6`, downloads the two model files, verifies their SHA-256 digests and checks that the worker can load them. It does not enroll anyone or seed attendance. Models are downloaded only during explicit setup; a missing model during a request fails closed with an actionable error. Model binaries and the virtual environment are generated installation artifacts, not business data.

### Required model files

Default directory: `HCM-backend/models/local-face/`.

| Filename | SHA-256 |
| --- | --- |
| `face_detection_yunet_2023mar.onnx` | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

The installer fetches official OpenCV Zoo assets from `media.githubusercontent.com/media/opencv/opencv_zoo/main/models/`; fixed hashes prevent silently accepting changed content. The official model source is pinned to OpenCV Zoo commit `48b10fa505aeb51fbd127fc60a5c660040e823b7` in the installer. Where the environment blocks Git LFS/media delivery, the installer can use the identical model bytes from [the pinned ordinary-Git mirror](https://github.com/sun0801/YuNet_SFace2/tree/d96f7798acb772a8383267b471d2ff2bd0d32701), still requiring the exact official SHA-256 values above. Both mirrored files were independently downloaded and matched those hashes; the official model licenses remain included. No TLS checks or artifact verification are disabled. An offline deployment can copy exactly these verified files and install the pinned Python packages from an approved package mirror.

## Configuration

- `BIOMETRIC_TEMPLATE_KEY`: base64 encoding of exactly 32 cryptographically random bytes for AES-256-GCM. `npm run setup:env` creates a local development key without printing it and preserves an existing valid key. For production, provision a stable backend secret; never use a public/frontend variable or paste the key into chat.
- `BIOMETRIC_TEMPLATE_KEY_ID`: encryption key version, default `v1`. Preserve the key for existing templates; automatic key rotation/migration is not implemented.
- `BIOMETRIC_MODEL_DIR`: optional absolute path to the two model files; default `models/local-face` relative to the backend.
- `BIOMETRIC_PYTHON_PATH`: optional Python executable override; default the backend `.local-face-venv/bin/python`.
- `BIOMETRIC_MATCH_THRESHOLD`: cosine threshold, default `0.363`, following the OpenCV SFace example. This is a starting point, not an attendance fraud/security certification; validate an appropriate stricter threshold with your workforce and devices.
- `BIOMETRIC_RETENTION_DAYS`: server cap, default 365, constrained to 1–365 days; company policy can shorten it.
- Company Admin settings: valid IANA timezone, office start/end, maximum shift hours, office coordinates/radius and retention. Face attendance checks submitted GPS accuracy no worse than 100 m and server-calculated office distance.
- `TRUST_PROXY`: trust only the actual TLS terminator(s), default `loopback`. HTTPS and secure session cookies are required in production. Camera access is limited to secure browser contexts; localhost is allowed during development.

`JWT_SECRET` remains a stable backend signing secret of at least 32 random characters. The loader reads the backend's own `.env` regardless of launch directory; injected values take precedence. `npm run setup:env` can repair a missing/short local signing key, preserving valid keys and other configuration. Correct or unset a short injected value rather than expecting dotenv to override it.

`AI_API_KEY` is unrelated to local biometrics. It remains optional for hosted chat, summaries and smart-leave interpretation only. Missing/blank keys disable those controls and direct AI requests return `503 AI_NOT_CONFIGURED`; ordinary forms and database workflows continue without fabricated responses.

## Backend and frontend changes

The employee/HR Face Enrollment page displays versioned biometric consent, expiry/deletion information and the absence of robust anti-spoofing. Following an explicit gesture, the browser requests camera permission and collects three bounded JPEG samples from the camera video. There is no photograph upload interface. Cancel, timeout, navigation and errors release camera tracks. Denied permission, no device and busy-camera cases provide honest retry/manual-alternative messages.

The backend receives the samples under a short-lived, employee/company/user/purpose-bound single-use challenge. It independently decodes the images, requires exactly one usable face per sample, aligns from detected landmarks and computes normalized SFace embeddings. It does not accept client embeddings, similarity scores or verification-success flags. An encrypted enrollment template is associated with the authenticated employee. Check-in/out compare actual local model outputs with the decrypted template, then apply the normal attendance writer in a MongoDB transaction. A recognized face alone cannot bypass employment status, geofence, shift rules, payroll locks or duplicate prevention.

No raw photograph or video is persisted by the application. Samples are transient request/worker data. Operators must also disable request-body/image logging and configure infrastructure retention appropriately. JavaScript/Python garbage collection and operating-system memory management do not provide a guarantee of physical memory erasure.

### Models and isolation

- `Company`: IANA timezone, office/shift/geofence/calendar policy and `biometricRetentionDays`.
- `BiometricEnrollment`: company/employee ownership, local provider/model version, encrypted `protectedTemplate`, consent version/time, enrollment/expiry and verification/deletion metadata. Template fields are excluded from normal queries and API views.
- `BiometricChallenge`: company/employee/user/purpose, expiry, attempts and consumed/failure state; short-lived and single-use. Expired challenge documents are later TTL-cleaned.
- `Attendance`: unique company/employee/business-date record, real check-in/out timestamps and working hours, policy snapshot, separate verification metadata for check-in/out.
- `AuditLog`: scoped consent, verification and deletion lifecycle events without face images or embeddings.

AES-256-GCM authenticates templates with company/employee-bound associated data. Company scope intersects ordinary authenticated queries and analytics joins. Company business keys use compound uniqueness; login emails remain globally unique because login does not have a tenant selector.

### API endpoints

Every biometric endpoint requires an active authenticated account with completed temporary-password rotation. Mutations enforce company/role/profile ownership. All biometric routes require HTTPS in production, including status/deletion. Face capture, enrollment and verification also have request/verification-attempt limits.

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/biometrics/status` | Local model/configuration readiness, consent notice and enrollment metadata; no template |
| `POST /api/biometrics/challenges` | Create purpose-bound challenge; enrollment requires explicit current consent |
| `POST /api/biometrics/enrollment` | `{challengeId, samples}`; independently infer and store encrypted template |
| `POST /api/biometrics/attendance` | `{challengeId, action, location, samples}`; infer identity and atomically write check-in/out |
| `DELETE /api/biometrics/enrollment` | Withdraw consent and delete own local enrollment |
| `DELETE /api/biometrics/enrollment/:employee` | Authorized staff revocation within their company |
| `POST /api/attendance/check-in` / `check-out` | Authorized non-biometric alternative |
| `GET /api/attendance/analytics` | Company/role-scoped real MongoDB aggregates and history |
| `POST /api/corrections` / `PATCH /api/corrections/:id` | Employee correction request / authorized HR review |
| `GET /api/ai/status` | Optional hosted-AI availability, independent of face models |

## Security, liveness and accuracy limitations

**This is local identity matching, not robust presentation-attack detection (PAD).** YuNet detects faces and landmarks; SFace compares identities. Neither model proves a live person is present. Requiring camera capture, several samples, blinking or head movement does not defeat photographs, screen replays, virtual cameras or a modified client. The server cannot attest that received JPEGs originated from a physical live camera. Challenge expiry/consumption prevents challenge reuse, not replay of previously captured face imagery in a fresh challenge.

The UI and consent notice disclose this limitation. Use controlled attendance conditions and the authorized web/HR correction alternative according to company policy. Do not treat the face method as high-assurance authentication or deploy it for unattended fraud prevention without independently validated local PAD and device/capture controls. No anti-spoofing accuracy is claimed. Browser GPS can also be falsified; the geofence checks policy coordinates, not device attestation. Account authentication authorizes enrollment but does not independently prove the first captured face is the employee’s legal identity; organizations needing that assurance should supervise enrollment.

Lighting, pose, glasses, masks, camera resolution, age and demographic differences can affect false accept/reject rates. A small fixture test is not population accuracy or bias validation. Calibrate thresholds, assess accessibility and legal consent requirements with the intended population, and keep an accessible non-biometric process. Inference is CPU-bound; apply the supplied request/rate/queue limits and size capacity for your deployment.

### Local PAD investigation

The official [MiniVision Silent-Face-Anti-Spoofing project](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) was reviewed as a possible local passive RGB PAD implementation. It publishes MiniFASNetV1/V2 architectures and test/training code; its repository [LICENSE](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/LICENSE) is Apache-2.0. Its [English README](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/README_EN.md#before-test-you-must-know) expressly warns that performance depends on the camera and scene and that test images must be camera-collected. Its published requirements pin older PyTorch1.2, torchvision0.4, NumPy1.17 and OpenCV4.2, so integrating the proposed checkpoint into this modern runtime would require a reviewed port/conversion and verified preprocessing.

It has not been integrated or represented as working liveness. No physical print, screen-replay, mask or injected-stream attack evaluation was performed here, and upstream benchmark numbers cannot establish this application's security. A future local PAD addition must check its exact checkpoint/dependency licensing, validate conversion/output equivalence, calibrate thresholds and measure bona-fide rejection and attack acceptance on the intended devices/conditions. Basic blinking/head motion remains insufficient evidence. This investigation supports the explicit current `liveness.supported: false` status rather than an untested anti-spoofing claim.

### Retention and deletion

Consent is voluntary and versioned (`2026-10-25-local-v1`). Withdrawal, employment exit or account deactivation disables recognition; the retention worker removes expired/queued local templates. The effective retention is the stricter company policy and server cap. Local deletion removes the encrypted database template and invalidates outstanding challenges. Re-enrollment requires fresh consent/capture.

Deletion from the live MongoDB collection is not certified physical erasure from disks, replicas, logs or backups. Define backup expiry/access and deletion procedures with your database operator. Preserve encryption keys until required retention/deletion work is complete.

Legacy AWS references cannot be converted into local embeddings and are never accepted by local verification. Existing legacy records, if any, remain disabled with their encrypted cleanup reference; a pending/manual legacy-cleanup response must not be described as provider deletion. Removing a local database record does not delete a previously AWS-held template. No AWS enrollment was created by this environment's earlier tests. New local enrollment and inference do not call AWS or require its credentials.

## Attendance analytics remain real

The existing dark-theme dashboards retain actual MongoDB daily/weekly/monthly counts, present/absent/late/on-leave rates, department comparisons and employee history. Recharts uses API values, with date/authorized department/employee filters, accessible tables and loading/empty/error states. Visible tabs poll every 15 seconds and refresh on attendance changes/focus; this is not server-push streaming. Employee views are self-scoped; staff views remain company-scoped.

Attendance uses company-local business dates and actual UTC elapsed hours, including overnight shifts and DST. Saved policy snapshots and finalized payroll locks are retained. Historical unrecorded absence uses current calendar rules because the legacy application does not maintain effective-dated policy history; saved attendance stays visible when policy changes. No artificial business records or chart values fill empty states.

## Verification

Run `npm test` in the backend with a real MongoDB replica set, and `npm run lint && npm run build` in the frontend. Automated fixtures use unique isolated `hcm_test_*` databases and never seed application data. Real-inference tests require the actual local model/runtime setup above; missing assets must not be reported as a successful recognition test.

Executed local replacement checks:

- `bash scripts/setup-local-face.sh`: pinned Python packages installed; both real model files passed exact official SHA-256 verification; OpenCV 4.13.0 loaded both models successfully.
- Actual CPU inference smoke: NASA astronaut fixture versus a transformed version scored `0.9140` cosine; the different US Navy Grace Hopper fixture scored `0.1395`, against the configured `0.363` threshold. These are observed fixture results, not advertised accuracy estimates.
- `node --test tests/local-biometric-integration.test.js`: **12 checks passed, zero failed/skipped**, using real model inference and a real isolated MongoDB database. This covers encrypted consented enrollment; genuine/rejected identity comparison; zero/multiple-face rejection; check-in persistence and analytics; duplicate prevention; check-out/hours; account/company challenge isolation; deletion/re-enrollment; missing-model errors with ordinary web fallback; authorization, fake-flag rejection and hidden templates/audits. AI/AWS keys were absent. The isolated database was removed afterward.

The full backend regression run passed **65/65 checks, zero failed/skipped**. After strengthening HTTPS enforcement for every biometric route, the focused local-integration suite passed **13/13 checks**, including the new production-HTTPS regression. This is not a claim that a 66-check full-suite run occurred. Fresh frontend lint and a 49-route production build passed.

Chromium also passed the actual `getUserMedia` and canvas flow using a public-domain fixture-video/Y4M camera stream: enrollment ran through real local inference; face check-in/out persisted and refreshed MongoDB-derived analytics; withdrawal/deletion worked; denied camera permission created no enrollment; and the 375px layout had no horizontal page overflow or browser runtime errors. The test used an isolated database and fixture camera stream, not a physical person/camera. No API recognition results were mocked. All test records remain isolated from normal business data. Image-fixture inference, API persistence and camera-permission exercises are distinct from physical-camera verification or spoof-resistance testing. No physical user-camera/liveness/PAD accuracy certification is claimed.

## Prepared cloud environment

The injected remote MongoDB address previously failed SRV DNS resolution. The running preview uses the existing local database with:

```sh
MONGODB_URI='mongodb://127.0.0.1:27017/hcm_lite?replicaSet=hcm' bash /workspace/onboarding/start.sh
```

The remote value and existing local `.env` are preserved. Configure a reachable remote URI before intentionally using that database. A stale required `AI_API_KEY` metadata entry can be removed in environment settings; the configuration API cannot remove existing requirements. It does not change the application's optional-AI behavior.

Commit/push status is reported separately after final validation; existing history is preserved.
