import { actApp, deployApp, exportBackup, hubMetrics, importBackup, meshOp, serveVhost, snapshot, streamLogs } from "./engine.server";
import type { DeployInput } from "./types";
import { decideAccess, peerAddress, sameOriginOk } from "./access";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Management access = valid HUB_SECRET, or (when no valid secret) a *private TCP peer*
 * that is not relaying for someone else. Client-supplied headers (X-Forwarded-For, Host,
 * Origin, Referer) are never trusted on their own. See access.ts + access.test.ts.
 */
export function checkManagement(request: Request, mutating = false): { ok: true } | { ok: false; status: number; error: string } {
  const decision = decideAccess(request.headers, peerAddress(request), {
    secret: (process.env.HUB_SECRET || "").trim(),
    trustProxy: process.env.HUB_TRUST_PROXY === "1",
  });
  if (!decision.ok) {
    return {
      ok: false,
      status: 401,
      error: `Unauthorized (${decision.reason}). Set HUB_SECRET and send it in the x-hub-secret header, or use the Hub from your private network.`,
    };
  }
  if (mutating && decision.via !== "secret" && !sameOriginOk(request.headers)) {
    return { ok: false, status: 403, error: "Cross-origin request blocked." };
  }
  return { ok: true };
}

export function isTrustedManagement(request: Request): boolean {
  return checkManagement(request).ok;
}

export async function handleHub(request: Request): Promise<Response> {
  try {
    if (request.method === "GET") {
      // Snapshot is management data; still require trust for full state.
      const gate = checkManagement(request);
      if (!gate.ok) return json({ error: gate.error }, gate.status);
      return json(snapshot());
    }
    if (request.method !== "POST") return json({ error: "Phương thức không hỗ trợ." }, 405);

    const gate = checkManagement(request, true);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    const len = Number(request.headers.get("content-length") || 0);
    if (len > 4_000_000) return json({ error: "Payload quá lớn." }, 413);
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 4_000_000) return json({ error: "Payload quá lớn." }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: "JSON không hợp lệ." }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Thiếu nội dung." }, 400);
    const msg = body as { op?: string; id?: string; input?: DeployInput };
    if (msg.op === "deploy") {
      if (!msg.input) return json({ error: "Thiếu cấu hình deploy." }, 400);
      const result = deployApp(msg.input);
      return json(result, result.ok ? 200 : 400);
    }
    if (
      msg.op === "start" ||
      msg.op === "stop" ||
      msg.op === "restart" ||
      msg.op === "delete" ||
      msg.op === "activate" ||
      msg.op === "bind-domain" ||
      msg.op === "unbind-domain"
    ) {
      if (!msg.id) return json({ error: "Thiếu id ứng dụng." }, 400);
      const extra = (body as { domain?: string }).domain ? { domain: String((body as { domain?: string }).domain) } : undefined;
      const result = await actApp(msg.id, msg.op, extra);
      return json(result, result.ok ? 200 : 400);
    }
    if (msg.op === "peer-deploy" || msg.op === "resync" || msg.op === "bad-block") {
      const result = meshOp(msg.op);
      return json(result, result.ok ? 200 : 400);
    }
    if (msg.op === "metrics") {
      return json({ ok: true, metrics: hubMetrics() });
    }
    if (msg.op === "backup-export") {
      const result = exportBackup();
      return json(result, result.ok ? 200 : 400);
    }
    if (msg.op === "backup-import") {
      const bundle = (body as { bundle?: unknown }).bundle;
      const result = await importBackup(bundle);
      return json(result, result.ok ? 200 : 400);
    }
    return json({ error: "Thao tác không rõ." }, 400);
  } catch (error) {
    console.error("[ofie] hub error", error);
    return json({ error: "Hub gặp lỗi nhưng tiến trình chính vẫn sống." }, 500);
  }
}

export function handleLogs(request: Request): Response {
  try {
    const gate = checkManagement(request);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "";
    if (!id) return json({ error: "Thiếu id." }, 400);
    if (url.searchParams.get("stream") === "1") return streamLogs(id, request.signal);
    return json({ lines: [] });
  } catch (error) {
    console.error("[ofie] log error", error);
    return json({ error: "Không mở được log." }, 500);
  }
}

export function handleVhost(request: Request): Promise<Response> {
  // Public website content — intentionally open (sandboxed).
  // Host header enables customDomain routing behind external reverse proxy.
  return serveVhost(new URL(request.url).pathname, request.headers.get("host") || request.headers.get("x-forwarded-host"));
}

export function handleHealth(request?: Request): Response {
  // Public liveness: no app names/counts. Details only for trusted management callers.
  const base = { status: "healthy", timestamp: new Date().toISOString() };
  if (!request || !isTrustedManagement(request)) return json(base);
  const state = snapshot();
  return json({
    ...base,
    isolated: true,
    chainHeight: state.chain.height,
    chainValid: state.chain.valid,
    apps: state.apps.length,
  });
}
