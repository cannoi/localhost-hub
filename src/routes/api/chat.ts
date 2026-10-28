import { createFileRoute } from "@tanstack/react-router";
import { snapshot } from "@/lib/hub/engine.server";

function detectLang(text: string): "vi" | "en" {
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text) ||
      /\b(xin chào|cảm ơn|làm sao|thế nào|ứng dụng|sổ cái|giúp|tôi|bạn)\b/i.test(text)) {
    return "vi";
  }
  return "en";
}

function reply(message: string, lang: "vi" | "en"): string {
  const q = message.toLowerCase();
  let s: ReturnType<typeof snapshot> | null = null;
  try { s = snapshot(); } catch { /* engine may not be ready in some contexts */ }
  const total = s?.apps.length ?? 0;
  const running = s?.apps.filter((a) => a.status === "running").length ?? 0;
  const height = s?.chain.height ?? 0;
  const name = s?.hub.name ?? "Ofie Hub";

  const R = lang === "vi" ? {
    greet: `Xin chào! Tôi là trợ lý ${name}. Hiện có ${total} app (${running} đang chạy), chain #${height}. Bạn cần gì?`,
    help: "Bạn có thể Deploy site tĩnh / app Node·Python, Start/Stop, xem nhật ký và sổ cái P2P.",
    status: `Hub «${name}» · ${total} app · ${running} running · chain #${height} · chế độ cô lập.`,
    deploy: "Mở tab Ứng dụng → Deploy. Chọn Static hoặc Dynamic (Node/Python). App được ghi vào sổ cái.",
    ledger: "Sổ cái dùng Ed25519 + SHA-256. Mỗi deploy/start/stop/delete tạo một block có chữ ký.",
    fallback: "Hãy thử: «trạng thái», «cách deploy», «sổ cái», hoặc mô tả lỗi bạn gặp.",
  } : {
    greet: `Hello! I'm the ${name} assistant. You have ${total} apps (${running} running), chain #${height}. How can I help?`,
    help: "You can deploy static sites or Node/Python apps, start/stop them, view logs, and inspect the P2P ledger.",
    status: `Hub «${name}» · ${total} apps · ${running} running · chain #${height} · isolated mode.`,
    deploy: "Open the Apps tab → Deploy. Choose Static or Dynamic (Node/Python). The app is committed to the ledger.",
    ledger: "The ledger uses Ed25519 + SHA-256. Every deploy/start/stop/delete creates a signed block.",
    fallback: "Try: «status», «how to deploy», «ledger», or describe the issue.",
  };

  if (/^(hi|hello|hey|xin chào|chào|alo)\b/i.test(q)) return R.greet;
  if (/help|giúp|hướng dẫn|how to|làm sao|cách dùng/i.test(q)) return R.help;
  if (/status|trạng thái|tình trạng|health|bao nhiêu/i.test(q)) return R.status;
  if (/deploy|tạo app|thêm app|upload/i.test(q)) return R.deploy;
  if (/ledger|sổ cái|block|chain|ký/i.test(q)) return R.ledger;
  return R.fallback;
}

async function handle({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  let body: { message?: string; lang?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  const message = String(body.message || "").slice(0, 2000);
  const forced = body.lang === "vi" || body.lang === "en" ? body.lang : null;
  const lang = (forced || detectLang(message)) as "vi" | "en";
  return new Response(JSON.stringify({ ok: true, lang, reply: reply(message, lang) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: { handlers: { POST: handle } },
});
