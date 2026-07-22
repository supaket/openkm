# openkm — static learning site served by nginx (self-hosted deployment)
FROM nginx:1.27-alpine

# Replace the stock server config with our static-site config
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/openkm.conf

# Copy the site (build context is filtered by .dockerignore)
COPY . /usr/share/nginx/html

# Safety net: strip any build/meta/secret files that slipped through
RUN rm -rf /usr/share/nginx/html/.git \
           /usr/share/nginx/html/.github \
           /usr/share/nginx/html/deploy \
           /usr/share/nginx/html/Dockerfile \
           /usr/share/nginx/html/docker-compose.yml \
           /usr/share/nginx/html/.dockerignore \
    && find /usr/share/nginx/html -maxdepth 1 -name 'id_ed25519*' -delete 2>/dev/null || true

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/healthz >/dev/null 2>&1 || exit 1
