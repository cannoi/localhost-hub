import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, statSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOwnedProcess, ZipBudget, isSafeSlug, writePrivateAtomic, quarantine, procStartTime } from "./safety.ts";

const yes = () => true;

test("isOwnedProcess rejects unknown identity, reused pid, foreign cmdline", () => {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  mkdirSync(join(root, "4242"));
  // stat: pid (comm) state ppid ... field 22 = starttime ; after ')' index 19
  const fields = Array.from({ length: 30 }, (_, i) => String(i));
  fields[19] = "777";
  writeFileSync(join(root, "4242", "stat"), `4242 (node) S ${fields.slice(1).join(" ")}`.replace("S 1 2", "S 1 2"));
  writeFileSync(join(root, "4242", "cmdline"), "node\0/data/ofie-hub/apps/blog/server.cjs\0");
  const start = procStartTime(4242, root);
  assert.ok(start);
  const marker = "/data/ofie-hub/apps/blog/";
  assert.equal(isOwnedProcess({ pid: 4242, start, marker }, root), true);
  assert.equal(isOwnedProcess({ pid: 4242, start: "999999", marker }, root), false, "pid reuse (different start time)");
  assert.equal(isOwnedProcess({ pid: 4242, start, marker: "/other/" }, root), false, "foreign command line");
  assert.equal(isOwnedProcess({ pid: 4242, start: null, marker }, root), false, "unknown identity => never signal");
  assert.equal(isOwnedProcess({ pid: 1, start, marker }, root), false);
  assert.equal(isOwnedProcess({ pid: 31337, start, marker }, root), false, "missing pid");
});

test("ZipBudget enforces count, per-file and total limits before inflating", () => {
  const b = new ZipBudget();
  assert.equal(b.admit("a/", 0, yes), false);
  assert.equal(b.admit("x.exe", 10, () => false), false);
  assert.equal(b.admit("index.html", 10, yes), true);
  assert.throws(() => new ZipBudget().admit("big.js", 1_000_001, yes), /quá lớn/);
  const t = new ZipBudget();
  t.admit("a.js", 900_000, yes); t.admit("b.js", 900_000, yes);
  assert.throws(() => t.admit("c.js", 900_000, yes), /giải nén quá lớn/);
  const c = new ZipBudget();
  for (let i = 0; i < 40; i++) c.admit(`f${i}.txt`, 1, yes);
  assert.throws(() => c.admit("f41.txt", 1, yes), /quá nhiều/);
  assert.throws(() => new ZipBudget().admit("n.js", -1, yes));
});

test("slug validation blocks traversal", () => {
  for (const s of ["blog", "my-site-2", "a"]) assert.equal(isSafeSlug(s), true, s);
  for (const s of ["../etc", "a/b", "", ".hidden", "-x", "UP", "a".repeat(60), 5, null]) assert.equal(isSafeSlug(s), false, String(s));
});

test("writePrivateAtomic: 0600, atomic, keeps .bak; quarantine preserves bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  const f = join(dir, "state.json");
  writePrivateAtomic(f, "one");
  writePrivateAtomic(f, "two");
  assert.equal(readFileSync(f, "utf8"), "two");
  assert.equal(readFileSync(`${f}.bak`, "utf8"), "one");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readdirSync(dir).some((n) => n.endsWith(".tmp")), false);
  writeFileSync(f, "{broken");
  const q = quarantine(f, 1);
  assert.ok(q && existsSync(q) && readFileSync(q, "utf8") === "{broken");
  assert.equal(quarantine(join(dir, "nope")), null);
});
