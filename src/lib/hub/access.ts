/**
 * Management-access policy for the Hub. Pure functions, no framework imports,
 * so they can be unit-tested with `node --experimental-strip-types --test`.
 *
 * Threat model: anything in request headers (X-Forwarded-For, Host, Origin,
 * Referer) is attacker-controlled. Only (a) a valid secret or (b) the TCP peer
 * address reported by the server runtime can grant access.
 */
import { timingSafeEqual, createHash } from "node:crypto";

export type AccessEnv = {
  secret: string;
  /** Operator explicitly states a trusted reverse proxy sets x-forwarded-for. */
  trustProxy: boolean;
};

export type AccessDecision = { ok: true; via: "secret" | "private-peer" } | { ok: false; reason: string };

export function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, "");
  return v === "::1" || v === "localhost" || /^127\./.test(v);
}

export function isPrivateIp(raw: string): boolean {
  const ip = raw.trim().replace(/^::ffff:/i, "");
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

export function secretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function extractToken(headers: Pick<Headers, "get">): string {
  const h = headers.get("x-hub-secret") || headers.get("authorization") || "";
  const t = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : h;
  return t.trim();
}

/**
 * @param peer TCP peer address from the runtime socket, or null if unknown.
 */
export function decideAccess(
  headers: Pick<Headers, "get">,
  peer: string | null,
  env: AccessEnv,
): AccessDecision {
  // When an operator configures a secret, it is the ONLY way in: in Docker every client may
  // appear as the (private) bridge gateway, so network position proves nothing.
  if (env.secret) {
    return secretMatches(extractToken(headers), env.secret) ? { ok: true, via: "secret" } : { ok: false, reason: "bad-or-missing-secret" };
  }

  // No valid secret: only a private TCP peer may manage, and only when nothing
  // indicates the request was relayed from somewhere else.
  if (!peer) return { ok: false, reason: "peer-unknown" };
  if (!isPrivateIp(peer)) return { ok: false, reason: "public-peer" };

  const relayed = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"].some((k) => !!headers.get(k));
  if (relayed) {
    if (!env.trustProxy) return { ok: false, reason: "proxied-without-secret" };
    const xf = (headers.get("x-forwarded-for") || headers.get("x-real-ip") || "").split(",").map((s) => s.trim()).filter(Boolean);
    // With a trusted proxy every hop in the chain must be private.
    if (xf.length === 0 || !xf.every(isPrivateIp)) return { ok: false, reason: "public-client-behind-proxy" };
  }
  return { ok: true, via: "private-peer" };
}

/**
 * CSRF guard for cookie-less, IP-trusted mode: a state-changing request from a
 * browser must either carry no Origin or an Origin whose host equals Host.
 * (Secret-authenticated requests use a custom header and are not CSRF-able.)
 */
export function sameOriginOk(headers: Pick<Headers, "get">): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (headers.get("host") || "");
  } catch {
    return false;
  }
}

/** Best-effort extraction of the TCP peer from different server runtimes. Returns null when unknown. */
export function peerAddress(request: Request): string | null {
  const r = request as unknown as {
    ip?: unknown;
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } };
    node?: { req?: { socket?: { remoteAddress?: string } } };
  };
  const cand = [
    typeof r.ip === "string" ? r.ip : undefined,
    r.runtime?.node?.req?.socket?.remoteAddress,
    r.node?.req?.socket?.remoteAddress,
  ];
  for (const c of cand) if (typeof c === "string" && c) return c;
  return null;
}
