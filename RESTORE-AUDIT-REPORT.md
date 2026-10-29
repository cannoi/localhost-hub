# Restore and UI regression audit — SoloHost edition

## Baseline comparison
- The baseline is the user's originally uploaded `grok-workspace.zip`.
- Earlier generated ZIPs omitted 94 original files, including `.grok/` references/skills and the `attachments/` archive. This package is rebuilt from the original upload and retains its full original file inventory, then applies the targeted changes described below.
- The Pi Network static-site template adds one selector option and a dedicated generated HTML template. Existing Pioneer, blank, pasted HTML, ZIP, and dynamic app paths are left intact.
- The preview diagnosis helper is carried forward so missing Vite is reported as a dependency-install problem, not an app-code repair request.

## Files intentionally changed/added
- Changed: `src/components/hub/dashboard.tsx` (one template option).
- Changed: `src/lib/hub/engine.server.ts` (new `pi-network` template branch and generator).
- Changed: `scripts/with-app-env.mjs` (deterministic spawn diagnosis).
- Added: `scripts/with-app-env.test.mjs` (targeted spawn-diagnosis tests).
- Added: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `config_options.yml`, and SoloHost reports.

## Docker/SoloHost constraints
- No container isolation mount, Docker CLI dependency, or privileged mode is configured.
- Container uses an unprivileged `node` account and listens on `0.0.0.0:8080`.
- Dynamic child apps remain child processes inside the same container; this does not create separate Docker containers.

## Validation status
- Source-only script tests were run separately; see delivery summary for exact results.
- Production build, live preview, and a real SoloHost deployment require dependencies and Docker/platform access not available in this validation environment. They are not claimed as passed.
