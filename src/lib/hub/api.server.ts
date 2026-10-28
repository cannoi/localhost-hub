import { actApp, deployApp, meshOp, serveVhost, snapshot, streamLogs } from "./engine.server";
import type { DeployInput } from "./types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleHub(request: Request): Promise<Response> {
  try {
    if (request.method === "GET") return json(snapshot());
    if (request.method !== "POST") return json({ error: "Phương thức không hỗ trợ." }, 405);
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 2_000_000) return json({ error: "Payload quá lớn." }, 413);
    let body: unknown;
    try {
      body = await request.json();
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
    if (msg.op === "start" || msg.op === "stop" || msg.op === "restart" || msg.op === "delete" || msg.op === "activate") {
      if (!msg.id) return json({ error: "Thiếu id ứng dụng." }, 400);
      const result = await actApp(msg.id, msg.op);
      return json(result, result.ok ? 200 : 400);
    }
    if (msg.op === "peer-deploy" || msg.op === "resync" || msg.op === "bad-block") {
      const result = meshOp(msg.op);
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
  return serveVhost(new URL(request.url).pathname);
}

export function handleHealth(): Response {
  const state = snapshot();
  return json({
    status: "healthy",
    isolated: true,
    chainHeight: state.chain.height,
    chainValid: state.chain.valid,
    apps: state.apps.length,
    timestamp: new Date().toISOString(),
  });
}
