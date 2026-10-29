/** Pure safety helpers (no framework imports) — unit-tested in safety.test.ts */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

/* ---------- process ownership (PID reuse safe) ---------- */

export type PidRecord = { pid: number; start: string | null; marker: string };

/** Linux start time (clock ticks since boot) of a pid, or null when unreadable / non-Linux. */
export function procStartTime(pid: number, procRoot = "/proc"): string | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return after[19] ?? null; // field 22 overall
  } catch {
    return null;
  }
}

export function procCmdline(pid: number, procRoot = "/proc"): string | null {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

/**
 * A recorded child may be signalled only if the same pid still exists with the
 * same start time AND its command line contains our marker path. If identity
 * cannot be established (e.g. no /proc) the answer is "no" — never guess.
 */
export function isOwnedProcess(rec: PidRecord, procRoot = "/proc"): boolean {
  if (!Number.isInteger(rec.pid) || rec.pid <= 1) return false;
  if (!rec.start || !rec.marker) return false;
  if (procStartTime(rec.pid, procRoot) !== rec.start) return false;
  const cmd = procCmdline(rec.pid, procRoot);
  return !!cmd && cmd.includes(rec.marker);
}

/* ---------- ZIP limits (enforced BEFORE inflating) ---------- */

export const ZIP_LIMITS = { maxArchive: 1_500_000, maxTotalUnzipped: 2_000_000, maxFile: 1_000_000, maxFiles: 40 } as const;

export class ZipBudget {
  total = 0;
  count = 0;
  /** Returns false to skip the entry; throws when a hard limit is exceeded. */
  admit(name: string, originalSize: number, extAllowed: (n: string) => boolean): boolean {
    if (name.endsWith("/")) return false;
    if (!extAllowed(name)) return false;
    if (!Number.isFinite(originalSize) || originalSize < 0) throw new Error("ZIP không hợp lệ");
    if (originalSize > ZIP_LIMITS.maxFile) throw new Error("Một tệp trong ZIP quá lớn");
    this.count += 1;
    if (this.count > ZIP_LIMITS.maxFiles) throw new Error("ZIP quá nhiều tệp");
    this.total += originalSize;
    if (this.total > ZIP_LIMITS.maxTotalUnzipped) throw new Error("Nội dung giải nén quá lớn");
    return true;
  }
}

/* ---------- identifiers ---------- */

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export function isSafeSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

/* ---------- private atomic file write ---------- */

/** Atomic (tmp+rename) write with owner-only permissions; keeps one .bak of the previous file. */
export function writePrivateAtomic(file: string, data: string, keepBackup = true): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* non-posix fs */ }
  if (keepBackup && existsSync(file)) {
    try { copyFileSync(file, `${file}.bak`); chmodSync(`${file}.bak`, 0o600); } catch { /* best effort */ }
  }
  renameSync(tmp, file);
}

/** Preserve an unreadable/invalid state file instead of silently overwriting identity keys. */
export function quarantine(file: string, now = Date.now()): string | null {
  try {
    if (!existsSync(file)) return null;
    const dest = `${file}.corrupt-${now}`;
    copyFileSync(file, dest);
    try { chmodSync(dest, 0o600); } catch { /* ignore */ }
    return dest;
  } catch {
    return null;
  }
}
