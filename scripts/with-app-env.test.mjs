import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnoseSpawnError } from "./with-app-env.mjs";

test("missing Vite is classified as an environment dependency failure", () => {
  const root = mkdtempSync(join(tmpdir(), "preview-diagnosis-"));
  try {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "^8.2.0" } }));
    const result = diagnoseSpawnError("vite", Object.assign(new Error("spawn vite ENOENT"), { code: "ENOENT" }), root);
    assert.equal(result.code, "PREVIEW_DEPENDENCY_MISSING");
    assert.match(result.message, /Dependency installation is incomplete/);
    assert.match(result.message, /Do not modify application source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("other missing commands get a generic command-not-found diagnosis", () => {
  const result = diagnoseSpawnError("unknown-tool", Object.assign(new Error("missing"), { code: "ENOENT" }), "/tmp/no-project");
  assert.equal(result.code, "COMMAND_NOT_FOUND");
});

test("non-ENOENT spawn failures retain their original diagnostic", () => {
  const result = diagnoseSpawnError("vite", Object.assign(new Error("permission denied"), { code: "EACCES" }), "/tmp/no-project");
  assert.equal(result.code, "PROCESS_START_FAILED");
  assert.equal(result.message, "permission denied");
});
