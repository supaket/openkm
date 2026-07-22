# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Thai Buddhist Chanting PWA (Progressive Web App) — a mobile-first web application for Thai Buddhist morning and evening prayers. Hosted on GitHub Pages at `supaket.github.io/openkm/` (repository: `github.com/supaket/openkm`).

## Architecture

**Single-file app**: The main chanting app lives entirely in `index.html` (~6000 lines) — all HTML, CSS, and JavaScript are inlined. There is no build system, bundler, or framework. Uses vanilla JS, CSS variables, and Web APIs (LocalStorage, Web Audio, Speech Synthesis).

**Supporting files:**
- `sw.js` — Service Worker for offline caching and auto-update
- `manifest.json` — PWA manifest
- `book-learning-hub.html` — Library/reading hub page
- `tech-docs-hub.html` — Technical documentation hub
- `calendar-practices.html` / `calendar-practices-v2.html` — Calendar/practice pages
- `books/` — Standalone HTML pages organized by category (business-finance, law-legal, personal-development, philosophy-strategy, communication-leadership, science-knowledge)
- `guides/technical/` — Technical guide HTML pages

Each HTML page in `books/` and `guides/` is a self-contained document with its own inline CSS/JS.

## Key Patterns

- **Day-of-week theming**: CSS custom properties (`--primary-*`) change based on `data-theme` attribute (sunday through saturday), each with a Thai auspicious color
- **PWA versioning**: When deploying updates, bump `CACHE_VERSION` in `sw.js` and the version in `index.html` footer simultaneously
- **All content is Thai language** — UI text, chanting text, and comments are primarily in Thai
- **No external JS dependencies** — everything is vanilla JavaScript
- **Google Analytics 4** is integrated (tag: `G-SEHP9YY4YX`)

## Deployment

Static site deployed via GitHub Pages from the `main` branch root. No build step — just commit and push.

**Self-hosted (Docker + GitHub Actions self-hosted runner)** — additive, does not replace Pages. On push to `main`, `.github/workflows/deploy.yml` (`runs-on: self-hosted`) builds an nginx image (`Dockerfile` + `deploy/nginx.conf`), pushes it to GHCR (`ghcr.io/supaket/openkm`), then `docker compose pull && up -d` on the runner host (served at root `/`, default port 8080). Local test: `docker compose up -d --build`. Full setup notes in `deploy/README.md`.
