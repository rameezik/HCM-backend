# Render backend with local face recognition

Use the repository's Dockerfile for the Render web service. The image installs Node24, Python3.11, pinned CPU OpenCV/NumPy wheels and both SHA-256-verified YuNet/SFace ONNX models. The build loads the real models; a failed install or model check fails the build. No inference request downloads a model. Use `render.yaml` to create a Docker service, or select this Dockerfile in Render. Changing an existing native Node service to Docker may require creating a Docker service and updating Vercel's target.

Set Render secrets/settings without committing their values:

- `MONGODB_URI`: the actual MongoDB Atlas connection URI; transactions require a replica set. URL-encode credentials in the URI and allow the Render service's actual outbound IP addresses in Atlas Network Access. A new Docker service can have different outbound addresses; do not blanket-open Atlas to all IPs.
- `JWT_SECRET`: preserve an existing strong key, or use Render's generated value for a new deployment.
- `BIOMETRIC_TEMPLATE_KEY`: a stable base64-encoded32-byte random key. Generate privately with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`; save it in Render's secret settings, never a frontend/public variable. Preserve the original key for existing enrollments.
- `FRONTEND_URL`: the exact deployed HTTPS Vercel origin, without a trailing slash. A comma-separated allowlist is supported.
- Optional `AUTH_APP_URL`: the canonical HTTPS frontend origin for password-reset links. It defaults to the first `FRONTEND_URL` origin.
- `TRUST_PROXY=1`: trust Render's immediate ingress hop. Use only behind that controlled ingress; other hosts must configure their actual trusted proxy topology.

On Vercel, set the server-side `API_INTERNAL_URL=https://<your-render-service>.onrender.com` and redeploy/restart the frontend. The browser continues to use same-origin `/api` and HttpOnly cookies. No database, JWT or biometric key belongs in Vercel's public variables. In production both the browser frontend and the Render endpoint must use HTTPS. Configure the company's office coordinates/radius and grant browser geolocation before face attendance; ordinary authorized attendance remains available without biometrics.

Render supplies `PORT`; do not force a public4000 port. The server already listens on the supplied port and all interfaces. Use `/api/health` as Render's readiness check.

Local installation without Docker remains:

```sh
npm ci
npm run setup:face
npm run setup:env
npm start
```

`setup:env` is for local development. Do not run it as a production startup step or rotate encryption keys on each restart. The free service may sleep and cold-start; local model inference uses CPU/RAM and can require a larger instance under load. YuNet/SFace identity matching does not provide reliable liveness or replay protection.

The Docker image built successfully and actual inference passed as the unprivileged `node` user (UID1000), with networking disabled. The image loaded OpenCV4.13.0, produced128-dimensional embeddings, accepted the transformed same-person fixture (cosine0.9140) and rejected the other-person fixture (0.1395) at threshold0.363. These are documented public-domain test photographs, not proof of physical-camera liveness or workforce accuracy. Runtime `.env` and build-only CA material were confirmed absent from the image.

The workspace's managed HTTPS proxy required an optional `hcm_build_ca` BuildKit secret using its already trusted CA bundle; TLS verification stayed enabled and that certificate bundle was not copied into the image. Standard Render public-HTTPS builds need no extra CA secret. A live Render deployment and Atlas connectivity from Render remain unverified; adding these files does not deploy the service.
