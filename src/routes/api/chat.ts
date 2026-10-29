import { createFileRoute } from "@tanstack/react-router";
import { snapshot } from "@/lib/hub/engine.server";
import { isTrustedManagement } from "@/lib/hub/api.server";
import { peerAddress } from "@/lib/hub/access";

const chatBuckets = new Map<string, number[]>();
function allowChat(ip: string): boolean {
  const now = Date.now();
  const list = (chatBuckets.get(ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= 30) {
    chatBuckets.set(ip, list);
    return false;
  }
  list.push(now);
  chatBuckets.set(ip, list);
  return true;
}

function detectLang(text: string): "vi" | "en" {
  if (
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text) ||
    /\b(xin chào|cảm ơn|làm sao|thế nào|ứng dụng|sổ cái|giúp|tôi|bạn)\b/i.test(text)
  ) {
    return "vi";
  }
  return "en";
}

function reply(message: string, lang: "vi" | "en", trusted: boolean): string {
  const q = message.toLowerCase();
  let s: ReturnType<typeof snapshot> | null = null;
  try {
    // Hub state (names, counts, domains) is management data: only shown to trusted callers.
    if (trusted) s = snapshot();
  } catch {
    /* engine may not be ready in some contexts */
  }
  const total = s?.apps.length ?? 0;
  const running = s?.apps.filter((a) => a.status === "running").length ?? 0;
  const height = s?.chain.height ?? 0;
  const name = s?.hub.name ?? "Ofie Hub";
  const domains =
    (s?.apps || [])
      .filter((a) => a.customDomain)
      .map((a) => a.customDomain)
      .join(", ") || "—";

  const R =
    lang === "vi"
      ? {
          greet: `Xin chào! Tôi là trợ lý ${name}. Hiện có ${total} app (${running} đang chạy), chain #${height}. Bạn cần gì?`,
          help: "Bạn có thể Deploy site tĩnh / app Node·Python, Start/Stop, gắn domain metadata, xem nhật ký và sổ cái P2P.",
          status: `Hub «${name}» · ${total} app · ${running} running · chain #${height} · domain gắn: ${domains}.`,
          deploy:
            "Mở tab Ứng dụng → Deploy. Chọn Static hoặc Dynamic (Node/Python). Static sẵn sàng ngay; dynamic cần Start và health check cổng.",
          ledger: "Sổ cái dùng Ed25519 + SHA-256. Mỗi deploy/start/stop/delete tạo một block có chữ ký.",
          domain:
            "Domain chỉ lưu metadata trên Hub. Trỏ DNS A/CNAME về máy SoloHost, cấu hình reverse proxy tới cổng Hub (mặc định host 48080 → container 8080). TLS do proxy/Let's Encrypt cấp — Hub không tự giả lập chứng chỉ.",
          security:
            "Đặt HUB_SECRET trong SoloHost nếu mở Hub ra Internet. API quản trị chỉ cho mạng riêng hoặc khi có secret.",
          fallback: "Hãy thử: «trạng thái», «cách deploy», «domain», «bảo mật», «sổ cái».",
        }
      : {
          greet: `Hello! I'm the ${name} assistant. You have ${total} apps (${running} running), chain #${height}. How can I help?`,
          help: "You can deploy static sites or Node/Python apps, start/stop them, bind domain metadata, view logs, and inspect the P2P ledger.",
          status: `Hub «${name}» · ${total} apps · ${running} running · chain #${height} · bound domains: ${domains}.`,
          deploy:
            "Open the Apps tab → Deploy. Choose Static or Dynamic (Node/Python). Static is live immediately; dynamic needs Start plus port health check.",
          ledger: "The ledger uses Ed25519 + SHA-256. Every deploy/start/stop/delete creates a signed block.",
          domain:
            "Domains are metadata only. Point DNS A/CNAME to your SoloHost machine, then reverse-proxy to the Hub port (default host 48080 → container 8080). TLS is issued by your proxy/Let's Encrypt — the Hub never fakes certificates.",
          security:
            "Set HUB_SECRET in SoloHost if the Hub is reachable from the public Internet. Management APIs allow private networks or a valid secret.",
          fallback: "Try: «status», «how to deploy», «domain», «security», «ledger».",
        };

  if (/^(hi|hello|hey|xin chào|chào|alo)\b/i.test(q)) return R.greet;
  if (/help|giúp|hướng dẫn|how to|làm sao|cách dùng/i.test(q)) return R.help;
  if (/status|trạng thái|tình trạng|health|bao nhiêu/i.test(q)) return R.status;
  if (/deploy|tạo app|thêm app|upload/i.test(q)) return R.deploy;
  if (/ledger|sổ cái|block|chain|ký/i.test(q)) return R.ledger;
  if (/domain|dns|https|tls|ssl|chứng chỉ|proxy/i.test(q)) return R.domain;
  if (/secret|bảo mật|password|mật khẩu|security|auth/i.test(q)) return R.security;
  if (/backup|sao lưu|restore|khôi phục|export|import/i.test(q)) {
    return lang === "vi"
      ? "Mở tab Hệ thống → Xuất backup (JSON gồm ledger + khóa identity). Giữ file an toàn. Nhập backup sẽ dừng app động và đặt stopped — bấm Start sau khi khôi phục."
      : "Open the System tab → Export backup (JSON with ledger + identity keys). Keep the file safe. Import stops dynamic apps and sets them to stopped — Start them after restore.";
  }
  return R.fallback;
}

async function handle({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const ip = peerAddress(request) || "local"; // rate-limit on the TCP peer, not a spoofable header
  if (!allowChat(ip)) {
    return new Response(JSON.stringify({ error: "Too many chat requests" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
  let body: { message?: string; lang?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* empty */
  }
  const message = String(body.message || "").slice(0, 2000);
  const forced = body.lang === "vi" || body.lang === "en" ? body.lang : null;
  const lang = (forced || detectLang(message)) as "vi" | "en";
  return new Response(JSON.stringify({ ok: true, lang, reply: reply(message, lang, isTrustedManagement(request)) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: { handlers: { POST: handle } },
});
