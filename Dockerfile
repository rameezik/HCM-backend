FROM node:24-bookworm-slim

# Render's Docker runtime provides a predictable Node + Python environment;
# OpenCV runs on CPU and never needs a paid inference service or GPU.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Optional build-only CA secret supports a managed corporate/CI HTTPS proxy
# without disabling certificate verification or copying its CA into the image.
RUN --mount=type=secret,id=hcm_build_ca \
    if [ -r /run/secrets/hcm_build_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/hcm_build_ca npm ci --omit=dev --no-audit --no-fund; \
    else npm ci --omit=dev --no-audit --no-fund; fi

COPY scripts/local-face/ ./scripts/local-face/
COPY scripts/setup-local-face.sh ./scripts/setup-local-face.sh
# Install dependencies, verify both official model SHA-256 hashes, and load the
# actual detection and embedding models during the build. No credentials needed.
RUN --mount=type=secret,id=hcm_build_ca \
    if [ -r /run/secrets/hcm_build_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/hcm_build_ca \
      PIP_CERT=/run/secrets/hcm_build_ca SSL_CERT_FILE=/run/secrets/hcm_build_ca npm run setup:face; \
    else npm run setup:face; fi \
    && rm -rf /tmp/hcm-face-pip-cache

COPY --chown=node:node . .
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER node
EXPOSE 4000
CMD ["node", "--use-env-proxy", "server.js"]
