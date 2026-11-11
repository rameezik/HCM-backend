# Deploying the face-attendance runtime fix

## Why a successful build could still report `configured: false`

The Admin employee API combines runtime/model checks, the biometric encryption key and numeric matching settings. MongoDB health and the installer’s earlier Python check did not validate all of these.

The previous Node code treated `BIOMETRIC_PYTHON_PATH=python3` as a file named `python3` in the working directory. Relative override paths also depended on the process working directory. Meanwhile, the installer checked its own virtual environment, even when the API was configured to run a different interpreter. The installer had also been duplicated.

The fix resolves Python commands through `PATH`, resolves relative files against the backend repository and checks the actual API-selected interpreter by loading both models. The Admin `configured` flag now includes that runtime check. Missing packages or corrupt models remain unavailable. A short cache deduplicates checks; changing model/runtime files invalidates it.

The runtime check does not bypass the encryption key, consent, employee photo, account, company or attendance checks. The exact deployed failing gate is shown by `missingConfiguration`; do not infer it from the build log alone.

If readiness passes but enrollment returns `503` after the encryption key was changed, follow [restore the original biometric key](restore-biometric-key.md). A new key can pass the format check while being unable to read existing templates.

## Existing native Node service on Render

Keep the current service and URL. Use the backend repository’s `main` branch and leave **Root Directory** empty unless the repository was deliberately nested.

**Build Command**

```sh
npm ci && npm run setup:face
```

**Start Command**

```sh
npm start
```

**Health Check Path:** `/api/health`

Use the current supported Python 3.13 installation and Node 24. The installer creates `.local-face-venv`, installs the pinned packages, verifies both ONNX hashes, and runs the same runtime check as the API.

Set these Render environment values:

```dotenv
NODE_ENV=production
BIOMETRIC_PYTHON_PATH=.local-face-venv/bin/python
BIOMETRIC_MODEL_DIR=models/local-face
BIOMETRIC_TEMPLATE_KEY_ID=v1
FRONTEND_URL=https://hcm-frontend-drab.vercel.app
TRUST_PROXY=1
```

Preserve the existing values of `MONGODB_URI`, `JWT_SECRET` and `BIOMETRIC_TEMPLATE_KEY`. `JWT_SECRET` needs at least 32 random characters. `BIOMETRIC_TEMPLATE_KEY` must encode exactly 32 random bytes as base64: normally 44 characters including the final `=`. Render’s generic 64-character hex secret is not this encoding. Do not rotate a valid existing encryption key: enrolled templates depend on it.

Only if no valid biometric key has ever been configured, generate one privately and save it in Render’s secret settings:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

No AWS or AI API key is required. Optional numeric settings may be omitted or blank to use the validated defaults:

| Setting | Default |
| --- | --- |
| `BIOMETRIC_MATCH_THRESHOLD` | `0.363` |
| `BIOMETRIC_RETENTION_DAYS` | `365` |
| `KIOSK_MATCH_THRESHOLD` | `0.55` |
| `KIOSK_MATCH_MARGIN` | `0.08` |
| `KIOSK_SCAN_COOLDOWN_SECONDS` | `30` |

Remove stale `/app/...` path overrides from a native Node service. `/app` belongs to the supplied Docker image; the portable relative values above work in either runtime. A bare Python command is supported, but it must point to an environment containing the required packages. The supplied virtual environment is the recommended interpreter.

Save the environment, then choose **Manual Deploy → Clear build cache & deploy** for this repair. Later deployments can use the normal build cache. Do not run `setup:env` in production.

## Docker services

Keep using the repository Dockerfile and `render.yaml`. The image now checks readiness as the unprivileged `node` user as well as during installation. The same relative path values above work under `/app`; do not copy native Render absolute paths into Docker. Keep existing secrets and the service’s assigned `PORT`.

## Vercel

Set this server-side environment variable for **Production**, then redeploy the frontend’s latest `main` commit:

```dotenv
API_INTERNAL_URL=https://hcm-backend-yrpy.onrender.com
```

`API_INTERNAL_URL` takes precedence over the older `NEXT_PUBLIC_API_URL` alias. Do not place database, JWT or biometric secrets in Vercel’s public variables. Browser requests continue to use the same-origin `/api` proxy.

## Verify after deployment

The backend startup log prints one safe readiness summary. In Render Shell, run:

```sh
npm run check:face
```

It exits successfully only if the selected runtime loads the models and all biometric configuration checks pass. Expected fields:

```json
{
  "configured": true,
  "missingConfiguration": [],
  "runtime": { "checked": true, "ready": true, "reason": null }
}
```

The command also shows interpreter/model paths, without printing secret values. `/api/health` proves database/API availability; it does not by itself prove face recognition readiness.

Sign in as Admin and open `/admin/attendance-terminal`. Select **Recheck readiness**. The authenticated `/api/attendance-terminal-management/employees` response must show `configured: true`, an empty `missingConfiguration` and `runtime.ready: true`. Otherwise, follow the Admin-only diagnostic panel rather than overriding the button.

With a real consenting employee, upload a clear photo, enable attendance, open the terminal link and scan. Confirm a saved check-in in the attendance portal; test check-out separately. An unknown face must show **Record not found** without writing attendance. Photo/video replay protection is not provided by YuNet/SFace.
