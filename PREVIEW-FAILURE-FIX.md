# Preview startup failure diagnosis / Chẩn đoán lỗi khởi chạy Preview

## Confirmed finding

The supplied workspace failed before the application could start:

```text
[with-app-env] failed to run vite: spawn vite ENOENT
```

The local `node_modules/.bin/vite` executable was absent, and the local `node_modules/vite` directory was incomplete. This is an environment/dependency-installation failure, not evidence of a source-code defect in the app. An install attempt could not complete in this environment because it timed out.

## Change made

`scripts/with-app-env.mjs` now classifies a missing local Vite executable as `PREVIEW_DEPENDENCY_MISSING` and prints a deterministic, actionable message. It explicitly instructs the repair flow not to modify application source or invoke AI repair for this signal. Other process-start errors retain separate classifications.

Tests added in `scripts/with-app-env.test.mjs` cover missing Vite, other missing commands, and non-ENOENT spawn failures.

## Validation

- Targeted source-only test set: 148 passed, 0 failed.
- Full package installation, TypeScript check, production build, and live HTTP preview could not be verified in this environment because dependency installation timed out and the Vite executable is unavailable.
- No container isolation mount or privileged mode was added.

## Next runtime requirement

The preview environment must complete installation from `package-lock.json` before starting `npm run dev`. Repeated source edits or rollback cannot repair a missing package executable. After dependencies are restored, rerun preview and diagnose any subsequent runtime/build signal separately.
