# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A static web app exploring an automatic shift-scheduling tool (自動排班工具) for May 2025. The UI is in Traditional Chinese (`lang="zh-TW"`). Hosted via GitHub Pages from the repository root (repo name ends in `.github.io`).

## Architecture

Three flat files at the repo root, no build step, no dependencies, no tests:

- `index.html` — single page. Loads `styles.css`, then `script.js`. Renders a button wired to `onclick="generateSchedule()"` and three output containers: `#schedule-output`, `#stats-output`, `#self-check-output`. Any scheduling feature added must populate these IDs.
- `styles.css` — page styling, including rules for `table`/`th`/`td` (the schedule is expected to render as an HTML table) and the two report panels (`#stats-output`, `#self-check-output`).
- `script.js` — **currently contains a duplicate of `styles.css`, not JavaScript.** The `generateSchedule()` function referenced by `index.html` is not defined anywhere in the repo, so the button is non-functional. Implementing `generateSchedule()` (and any helpers) in this file is the core outstanding work.

## Development

- Run locally by opening `index.html` directly in a browser, or serve the root with any static server (e.g. `python3 -m http.server`).
- No lint, test, or build commands exist. Don't invent scripts or add tooling unless asked.
- Deployment: pushing to the default branch of `*.github.io` publishes to GitHub Pages automatically — no CI config in the repo.

## Conventions

- Keep user-facing strings in Traditional Chinese to match existing copy.
- Preserve the flat file layout and the three output container IDs; `index.html` depends on them.
