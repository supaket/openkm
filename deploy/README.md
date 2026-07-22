# Self-hosted deployment (Docker + GitHub Actions self-hosted runner)

The site is static (no build step). Deployment packages it into an nginx
image, pushes it to **GHCR**, and (re)starts the container on the runner host.

```
push to main ─▶ self-hosted runner ─▶ docker build ─▶ docker push (ghcr.io)
                                                   └─▶ docker compose pull && up -d
```

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | nginx:alpine image, copies the site to `/usr/share/nginx/html` |
| `deploy/nginx.conf` | server config: gzip, cache rules, `/healthz`, `sw.js` no-cache |
| `docker-compose.yml` | runs image `ghcr.io/supaket/openkm:latest` on `${OPENKM_PORT:-8080}` |
| `.github/workflows/deploy.yml` | build → push → compose up on `runs-on: self-hosted` |
| `.dockerignore` | keeps `.git`, secrets (`id_ed25519*`), docs out of the image |

The site is served at **root `/`** (all app paths are relative, so no `/openkm/`
base-path rewrite is needed). GitHub Pages is untouched — this is additive.

## One-time setup on the runner host

1. **Install Docker + Compose v2** and confirm the runner user can use Docker:
   ```sh
   docker version && docker compose version
   sudo usermod -aG docker "$USER"   # then re-login
   ```

2. **Register the self-hosted runner** for the repo
   (GitHub → repo **Settings → Actions → Runners → New self-hosted runner**):
   ```sh
   mkdir actions-runner && cd actions-runner
   # download the tarball shown by GitHub for your OS, then:
   ./config.sh --url https://github.com/supaket/openkm --token <RUNNER_TOKEN>
   ./run.sh                 # or install as a service:
   sudo ./svc.sh install && sudo ./svc.sh start
   ```
   The workflow uses `runs-on: [self-hosted]`, so the default `self-hosted`
   label is enough.

3. **Allow GHCR pushes.** The workflow already requests `packages: write`, so the
   built-in `GITHUB_TOKEN` can push `ghcr.io/supaket/openkm`. After the first
   run, set the package visibility (public/private) under the repo's **Packages**.

4. *(optional)* **Port / image overrides** — create `.env` next to
   `docker-compose.yml` on the host, or set a repo variable `OPENKM_PORT`:
   ```sh
   OPENKM_PORT=8080
   ```

## Trigger

- Automatic on every push to `main` (doc/CI-only pushes are skipped).
- Manual: GitHub → **Actions → Build & Deploy (self-hosted) → Run workflow**.

## Local test (no runner needed)

```sh
docker compose up -d --build
curl -s localhost:8080/healthz      # -> ok
# open http://localhost:8080/
docker compose down
```

## Rollback

Images are tagged with the commit SHA:
```sh
OPENKM_IMAGE=ghcr.io/supaket/openkm:<sha> docker compose up -d
```
