import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Blocks,
  CircleStop,
  Download,
  Globe,
  HardDrive,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldOff,
  Share2,
  Trash2,
  Upload,
  Waypoints,
  Workflow,
} from "lucide-react";
import { previewPathPrefix } from "@/lib/preview-path-prefix";
import type { AppView, HubMetrics, HubSnapshot, LogLine } from "@/lib/hub/types";

type Tab = "apps" | "logs" | "ledger" | "mesh" | "flow" | "system" | "chat";
type Lang = "vi" | "en";

const LABELS: Record<Lang, Record<string, string>> = {
  vi: {
    apps: "Ứng dụng", logs: "Nhật ký", ledger: "Sổ cái", mesh: "Mesh", flow: "Luồng", system: "Hệ thống", chat: "Chat AI",
    height: "Cao", running: "Chạy", mode: "Chế độ", deploy: "Deploy",
    chatPlaceholder: "Hỏi về hub… (trạng thái, deploy, domain, backup)",
    send: "Gửi",
    chatWelcome: "Xin chào! Hỏi bằng tiếng Việt hoặc English — tôi trả lời theo ngôn ngữ của bạn.",
    domain: "Domain", bind: "Gắn", unbind: "Gỡ", backup: "Sao lưu", restore: "Khôi phục",
    metrics: "Tài nguyên", exportBackup: "Xuất backup", importBackup: "Nhập backup",
    unlockTitle: "Cần mật khẩu quản trị", unlockHint: "Nhập HUB_SECRET đã đặt trong cấu hình SoloHost.", unlockBtn: "Mở khóa", unlockClear: "Quên mật khẩu đã lưu",
  },
  en: {
    apps: "Apps", logs: "Logs", ledger: "Ledger", mesh: "Mesh", flow: "Flow", system: "System", chat: "AI Chat",
    height: "Height", running: "Running", mode: "Mode", deploy: "Deploy",
    chatPlaceholder: "Ask about the hub… (status, deploy, domain, backup)",
    send: "Send",
    chatWelcome: "Hi! Ask in English or Vietnamese — I reply in your language.",
    domain: "Domain", bind: "Bind", unbind: "Unbind", backup: "Backup", restore: "Restore",
    metrics: "Resources", exportBackup: "Export backup", importBackup: "Import backup",
    unlockTitle: "Management password required", unlockHint: "Enter the HUB_SECRET set in your SoloHost config.", unlockBtn: "Unlock", unlockClear: "Forget saved password",
  },
};

const TAB_IDS: { id: Tab; icon: typeof Waypoints }[] = [
  { id: "apps", icon: Waypoints },
  { id: "logs", icon: ScrollText },
  { id: "ledger", icon: Blocks },
  { id: "mesh", icon: Share2 },
  { id: "flow", icon: Workflow },
  { id: "system", icon: Settings2 },
  { id: "chat", icon: Radio },
];

function apiUrl(path: string): string {
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
  return `${prefix}${path}`;
}

function hubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  try {
    const secret = typeof window !== "undefined" ? localStorage.getItem("ofie-hub-secret") : null;
    if (secret) headers["x-hub-secret"] = secret;
  } catch { /* ignore */ }
  return headers;
}

async function postHub(body: unknown): Promise<{ ok?: boolean; error?: string; note?: string; metrics?: HubMetrics; bundle?: unknown }> {
  const response = await fetch(apiUrl("/api/hub"), {
    method: "POST",
    headers: hubHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { ok?: boolean; error?: string; note?: string; metrics?: HubMetrics; bundle?: unknown };
  if (!response.ok || data.ok === false) throw new Error(data.error || "Thao tác thất bại");
  return data;
}

function statusLabel(status: AppView["status"]): string {
  if (status === "running") return "Running";
  if (status === "stopped") return "Stopped";
  if (status === "crashed") return "Crashed";
  if (status === "starting") return "Starting";
  return "Standby";
}

function lampClass(status: AppView["status"]): string {
  if (status === "running" || status === "starting") return "bg-primary";
  if (status === "crashed") return "bg-alert";
  if (status === "standby") return "bg-primary/70";
  return "bg-muted";
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ts);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const index = value.indexOf(",");
      resolve(index >= 0 ? value.slice(index + 1) : value);
    };
    reader.onerror = () => reject(new Error("Không đọc được ZIP"));
    reader.readAsDataURL(file);
  });
}

export function Dashboard() {
  const [snap, setSnap] = useState<HubSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("apps");
  const [panel, setPanel] = useState<Exclude<Tab, "apps">>("logs");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [secretInput, setSecretInput] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<HubMetrics | null>(null);
  const termRef = useRef<HTMLPreElement>(null);
  const [lang, setLang] = useState<Lang>(() => {
    if (typeof window === "undefined") return "vi";
    const saved = localStorage.getItem("ofie-lang");
    if (saved === "en" || saved === "vi") return saved;
    return (navigator.language || "").startsWith("vi") ? "vi" : "en";
  });
  const [chatInput, setChatInput] = useState("");
  const [chatMsgs, setChatMsgs] = useState<{ role: "user" | "bot"; text: string }[]>([]);
  const L = LABELS[lang];
  const TABS = TAB_IDS.map((item) => ({ ...item, label: L[item.id] || item.id }));

  async function refresh() {
    try {
      const response = await fetch(apiUrl("/api/hub"), { headers: hubHeaders() });
      if (response.status === 401) {
        setNeedsAuth(true);
        throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "Unauthorized");
      }
      if (!response.ok) throw new Error("Hub không phản hồi");
      setNeedsAuth(false);
      const data = (await response.json()) as HubSnapshot;
      setSnap(data);
      setError(null);
      setSelected((current) => {
        if (current && data.apps.some((app) => app.id === current)) return current;
        return data.apps.find((app) => app.kind === "dynamic")?.id ?? data.apps[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mất kết nối Hub");
    }
  }

  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (!stop && document.visibilityState !== "hidden") void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 2500);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLines([]);
    const ctrl = new AbortController();
    const push = (raw: string) => {
      for (const block of raw.split("\n\n")) {
        const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (!data) continue;
        try {
          const line = JSON.parse(data) as LogLine;
          setLines((current) => {
            const next = [...current, line];
            return next.length > 240 ? next.slice(next.length - 240) : next;
          });
        } catch {
          /* ignore malformed line */
        }
      }
    };
    void (async () => {
      try {
        // fetch (not EventSource) so the x-hub-secret header can be sent.
        const res = await fetch(apiUrl(`/api/logs?id=${encodeURIComponent(selected)}&stream=1`), { headers: hubHeaders(), signal: ctrl.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const cut = buf.lastIndexOf("\n\n");
          if (cut >= 0) {
            push(buf.slice(0, cut + 2));
            buf = buf.slice(cut + 2);
          }
        }
      } catch {
        /* aborted or disconnected */
      }
    })();
    return () => ctrl.abort();
  }, [selected]);

  useEffect(() => {
    const node = termRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines, tab, panel]);

  useEffect(() => {
    if (tab !== "system") return;
    void (async () => {
      try {
        const res = await postHub({ op: "metrics" });
        if (res.metrics) setMetrics(res.metrics);
      } catch {
        /* ignore */
      }
    })();
  }, [tab]);

  const right = tab === "apps" ? panel : tab === "logs" || tab === "ledger" || tab === "mesh" || tab === "flow" || tab === "system" ? tab : "logs";
  const running = snap?.apps.filter((app) => app.status === "running").length ?? 0;
  const crashed = snap?.apps.filter((app) => app.status === "crashed").length ?? 0;

  function switchLang(next: Lang) {
    setLang(next);
    try { localStorage.setItem("ofie-lang", next); } catch { /* ignore */ }
  }

  async function sendChat() {
    const message = chatInput.trim();
    if (!message) return;
    setChatInput("");
    setChatMsgs((m) => [...m, { role: "user", text: message }]);
    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: hubHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message, lang }),
      });
      const data = (await response.json()) as { reply?: string };
      setChatMsgs((m) => [...m, { role: "bot", text: data.reply || "…" }]);
    } catch {
      setChatMsgs((m) => [...m, { role: "bot", text: lang === "vi" ? "Không kết nối được trợ lý." : "Assistant unavailable." }]);
    }
  }

    async function run(label: string, task: () => Promise<{ note?: string } | void>) {
    setBusy(label);
    setError(null);
    try {
      const result = await task();
      if (result && "note" in result && result.note) setNote(result.note);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi");
    } finally {
      setBusy(null);
      setConfirmId(null);
    }
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-fg">
              <Waypoints aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-mono text-xs tracking-widest text-primary">OFIE MESH</p>
              <h1 className="text-balance text-xl font-semibold leading-tight">Localhost Hub</h1>
              <p className="text-pretty text-sm text-muted">Web tĩnh, child process, sổ cái ký chung.</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-1">
              <button type="button" onClick={() => switchLang("en")} className={`rounded-md border px-2 py-1 text-xs font-semibold ${lang === "en" ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-muted"}`}>EN</button>
              <button type="button" onClick={() => switchLang("vi")} className={`rounded-md border px-2 py-1 text-xs font-semibold ${lang === "vi" ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-muted"}`}>VI</button>
            </div>
            <dl className="grid grid-cols-3 gap-2 font-mono text-xs">
              <Stat label={L.height} value={snap ? String(snap.chain.height) : "—"} />
              <Stat label={L.running} value={snap ? String(running) : "—"} />
              <Stat label={L.mode} value="isolated" />
            </dl>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-4">
        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Khu vực Hub">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`flex h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm ${
                  active
                    ? "border-primary bg-primary text-primary-fg"
                    : "border-border bg-surface text-fg"
                }`}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {needsAuth ? (
          <form
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              try { localStorage.setItem("ofie-hub-secret", secretInput.trim()); } catch { /* ignore */ }
              setSecretInput("");
              void refresh();
            }}
          >
            <span className="font-medium">{L.unlockTitle}</span>
            <span className="text-muted">{L.unlockHint}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1"
              aria-label={L.unlockTitle}
            />
            <button type="submit" className="rounded-md border border-border px-3 py-1">{L.unlockBtn}</button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-muted underline"
              onClick={() => { try { localStorage.removeItem("ofie-hub-secret"); } catch { /* ignore */ } void refresh(); }}
            >
              {L.unlockClear}
            </button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 rounded-lg border border-alert bg-surface px-3 py-2 text-sm text-alert">
            {error}
          </p>
        ) : null}
        {note ? (
          <p className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">{note}</p>
        ) : null}


        {tab === "chat" ? (
          <div className="mt-4 rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 max-h-80 min-h-[16rem] space-y-2 overflow-y-auto rounded-lg border border-border bg-bg p-3 text-sm">
              {(chatMsgs.length ? chatMsgs : [{ role: "bot" as const, text: L.chatWelcome }]).map((m, i) => (
                <div key={i} className={`max-w-[92%] rounded-lg px-3 py-2 ${m.role === "user" ? "ml-auto bg-primary text-primary-fg" : "bg-surface-2 text-fg"}`}>{m.text}</div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void sendChat(); }}
                placeholder={L.chatPlaceholder}
                className="h-11 flex-1 rounded-lg border border-border bg-bg px-3 text-sm"
              />
              <button type="button" onClick={() => void sendChat()} className="h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg">{L.send}</button>
            </div>
          </div>
        ) : null}

        <div className={`mt-4 lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-4 ${tab === "chat" ? "hidden" : ""}`}>
          <section className={tab !== "apps" ? "hidden lg:block" : ""} aria-label="Danh sách ứng dụng">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Ứng dụng trên hub này</h2>
              <button
                type="button"
                onClick={() => setDeployOpen((open) => !open)}
                className="flex h-11 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg"
              >
                <Plus aria-hidden="true" className="size-4" />
                Deploy
              </button>
            </div>
            {deployOpen ? (
              <DeployForm
                busy={busy === "deploy"}
                onSubmit={(input) =>
                  void run("deploy", async () => {
                    await postHub({ op: "deploy", input });
                    setDeployOpen(false);
                    setNote("Đã ghi app vào sổ cái và phát tán cho peer.");
                  })
                }
              />
            ) : null}
            {!snap ? (
              <p className="rounded-lg border border-border bg-surface px-4 py-8 text-sm text-muted">Đang nối Hub…</p>
            ) : snap.apps.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-4 py-8 text-sm text-muted">
                Chưa có app. Deploy một trang tĩnh hoặc beacon Node/Python.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {snap.apps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    selected={selected === app.id}
                    busy={busy === app.id}
                    confirm={confirmId === app.id}
                    lang={lang}
                    onSelect={() => {
                      setSelected(app.id);
                      setPanel("logs");
                      setTab((current) => (current === "apps" ? current : "logs"));
                    }}
                    onOpen={() => setPreview(app.slug)}
                    onAction={(op) => {
                      if (op === "delete" && confirmId !== app.id) {
                        setConfirmId(app.id);
                        return;
                      }
                      void run(app.id, () => postHub({ op, id: app.id }));
                    }}
                    onBindDomain={(domain) =>
                      void run(app.id, () => postHub({ op: "bind-domain", id: app.id, domain }))
                    }
                    onUnbindDomain={() =>
                      void run(app.id, () => postHub({ op: "unbind-domain", id: app.id }))
                    }
                  />
                ))}
              </ul>
            )}
            {snap && snap.mirrors.length > 0 ? (
              <div className="mt-6">
                <h2 className="mb-3 text-base font-semibold">Bản sao dự phòng</h2>
                <ul className="flex flex-col gap-3">
                  {snap.mirrors.map((app) => (
                    <li key={app.id} className="rounded-lg border border-border bg-surface p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{app.name}</p>
                          <p className="mt-1 font-mono text-xs text-muted">
                            từ {app.originName} · {app.slug}
                          </p>
                        </div>
                        <StatusLamp status={app.status} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setPreview(app.slug)}
                          className="h-11 rounded-lg border border-border bg-surface-2 px-3 text-sm"
                        >
                          Xem bản sao
                        </button>
                        <button
                          type="button"
                          disabled={busy === app.id}
                          onClick={() => void run(app.id, () => postHub({ op: "activate", id: app.id }))}
                          className="h-11 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg disabled:opacity-50"
                        >
                          Kích hoạt tại đây
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview ? (
              <div className="mt-4 overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
                  <p className="truncate font-mono text-xs text-muted">/api/vhost/{preview}/</p>
                  <button type="button" onClick={() => setPreview(null)} className="h-11 px-2 text-sm text-muted">
                    Đóng
                  </button>
                </div>
                <iframe
                  title={`Xem ${preview}`}
                  sandbox="allow-scripts"
                  className="h-80 w-full bg-bg"
                  src={apiUrl(`/api/vhost/${preview}/`)}
                />
              </div>
            ) : null}
            {crashed > 0 ? (
              <p className="mt-3 text-sm text-alert">{crashed} app đang Crashed. Mở nhật ký để xem stderr.</p>
            ) : null}
          </section>

          <aside className={tab === "apps" ? "mt-4 hidden lg:mt-0 lg:block" : "mt-4 lg:mt-0"}>
            <div className="mb-3 hidden gap-2 lg:flex" role="tablist" aria-label="Bảng bên">
              {(["logs", "ledger", "mesh", "flow"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setPanel(id);
                    setTab("apps");
                  }}
                  className={`h-11 rounded-lg border px-3 text-sm ${
                    right === id && tab === "apps"
                      ? "border-primary bg-surface-2 text-fg"
                      : "border-border bg-surface text-muted"
                  }`}
                >
                  {TABS.find((item) => item.id === id)?.label}
                </button>
              ))}
            </div>
            {right === "logs" ? (
              <LogPanel
                apps={snap?.apps ?? []}
                selected={selected}
                lines={lines}
                termRef={termRef}
                onSelect={setSelected}
              />
            ) : null}
            {right === "ledger" ? <LedgerPanel snap={snap} /> : null}
            {right === "mesh" ? (
              <MeshPanel
                snap={snap}
                busy={busy}
                onOp={(op) => void run(op, () => postHub({ op }))}
              />
            ) : null}
            {right === "flow" ? <FlowPanel snap={snap} /> : null}
            {right === "system" ? (
              <SystemPanel
                lang={lang}
                metrics={metrics}
                busy={busy}
                onRefreshMetrics={() =>
                  void run("metrics", async () => {
                    const res = await postHub({ op: "metrics" }) as { metrics?: HubMetrics };
                    if (res.metrics) setMetrics(res.metrics);
                  })
                }
                onExport={() =>
                  void run("backup", async () => {
                    const res = await postHub({ op: "backup-export" }) as { bundle?: unknown };
                    if (!res.bundle) throw new Error("No bundle");
                    const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `ofie-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setNote(lang === "vi" ? "Đã xuất backup JSON." : "Backup JSON downloaded.");
                  })
                }
                onImportFile={(file) =>
                  void run("restore", async () => {
                    const textFile = await file.text();
                    const bundle = JSON.parse(textFile);
                    const res = await postHub({ op: "backup-import", bundle });
                    setNote(res.note || (lang === "vi" ? "Đã khôi phục." : "Restored."));
                  })
                }
              />
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function StatusLamp({ status }: { status: AppView["status"] }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-muted">
      <span className={`size-2.5 rounded-full ${lampClass(status)} ${status === "starting" ? "animate-pulse" : ""}`} />
      {statusLabel(status)}
    </span>
  );
}

function AppCard({
  app,
  selected,
  busy,
  confirm,
  lang,
  onSelect,
  onOpen,
  onAction,
  onBindDomain,
  onUnbindDomain,
}: {
  app: AppView;
  selected: boolean;
  busy: boolean;
  confirm: boolean;
  lang: Lang;
  onSelect: () => void;
  onOpen: () => void;
  onAction: (op: "start" | "stop" | "restart" | "delete") => void;
  onBindDomain: (domain: string) => void;
  onUnbindDomain: () => void;
}) {
  const [domainInput, setDomainInput] = useState(app.customDomain || "");
  return (
    <li className={`rounded-lg border bg-surface p-4 ${selected ? "border-primary" : "border-border"}`}>
      <button type="button" onClick={onSelect} className="flex w-full items-start justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="block truncate font-semibold">{app.name}</span>
          <span className="mt-1 block font-mono text-xs text-muted">
            {app.kind === "static" ? (lang === "vi" ? "Web tĩnh" : "Static") : (lang === "vi" ? "App động" : "Dynamic")} · {app.runtime} · {app.slug}
          </span>
        </span>
        <StatusLamp status={app.status} />
      </button>
      <dl className="mt-4 grid grid-cols-2 gap-3 font-mono text-xs">
        <div>
          <dt className="text-muted">{lang === "vi" ? "Cổng nội bộ" : "Internal port"}</dt>
          <dd className="mt-1 tabular-nums text-fg">{app.internalPort ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">{lang === "vi" ? "Giám sát" : "Supervisor"}</dt>
          <dd className="mt-1 text-fg">{app.supervisor}</dd>
        </div>
        <div>
          <dt className="text-muted">Restart</dt>
          <dd className="mt-1 tabular-nums text-fg">{app.restarts}</dd>
        </div>
        <div>
          <dt className="text-muted">{lang === "vi" ? "Đường dẫn" : "Path"}</dt>
          <dd className="mt-1 truncate text-fg">{app.domain}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted flex items-center gap-1"><Globe className="size-3" aria-hidden /> Domain</dt>
          <dd className="mt-1 truncate text-fg">{app.customDomain || "—"}</dd>
        </div>
        {app.readyAt ? (
          <div className="col-span-2">
            <dt className="text-muted">Ready</dt>
            <dd className="mt-1 truncate text-fg">{app.readyAt}</dd>
          </div>
        ) : null}
      </dl>
      {app.lastError ? <p className="mt-3 text-sm text-alert">{app.lastError}</p> : null}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={domainInput}
          onChange={(e) => setDomainInput(e.target.value)}
          placeholder="example.com"
          className="h-11 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm"
          aria-label="Custom domain"
        />
        <button
          type="button"
          disabled={busy || !domainInput.trim()}
          onClick={() => onBindDomain(domainInput.trim())}
          className="h-11 rounded-lg border border-border bg-surface-2 px-3 text-sm disabled:opacity-50"
        >
          {lang === "vi" ? "Gắn domain" : "Bind domain"}
        </button>
        {app.customDomain ? (
          <button
            type="button"
            disabled={busy}
            onClick={onUnbindDomain}
            className="h-11 rounded-lg border border-border px-3 text-sm text-muted disabled:opacity-50"
          >
            {lang === "vi" ? "Gỡ" : "Unbind"}
          </button>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tiny onClick={() => onAction("start")} disabled={busy} icon={Play} label="Start" />
        <Tiny onClick={() => onAction("stop")} disabled={busy} icon={CircleStop} label="Stop" />
        <Tiny onClick={() => onAction("restart")} disabled={busy} icon={RotateCcw} label="Restart" />
        <Tiny onClick={() => onAction("delete")} disabled={busy} icon={Trash2} label={confirm ? (lang === "vi" ? "Xác nhận" : "Confirm") : (lang === "vi" ? "Xóa" : "Delete")} danger={confirm} />
      </div>
      <button type="button" onClick={onOpen} className="mt-2 h-11 w-full rounded-lg border border-border text-sm">
        {lang === "vi" ? "Mở trang" : "Open site"}
      </button>
    </li>
  );
}

function Tiny({
  onClick,
  disabled,
  icon: Icon,
  label,
  danger,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: typeof Play;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 items-center justify-center gap-1 rounded-lg border text-sm disabled:opacity-50 ${
        danger ? "border-alert text-alert" : "border-border bg-surface-2"
      }`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {label}
    </button>
  );
}

function DeployForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: {
    name: string;
    kind: "static" | "dynamic";
    template?: string;
    html?: string;
    runtime?: "node" | "python";
    zipBase64?: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"static" | "dynamic">("static");
  const [template, setTemplate] = useState("pioneer");
  const [runtime, setRuntime] = useState<"node" | "python">("node");
  const [html, setHtml] = useState("");
  const [zipName, setZipName] = useState("");
  const [zipBase64, setZipBase64] = useState<string | undefined>();

  return (
    <form
      className="mb-4 rounded-lg border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          name,
          kind,
          template: kind === "static" ? template : undefined,
          html: template === "paste" ? html : undefined,
          runtime: kind === "dynamic" ? runtime : undefined,
          zipBase64: template === "zip" ? zipBase64 : undefined,
        });
      }}
    >
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          Tên
          <input
            required
            minLength={2}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 rounded-lg border border-border bg-bg px-3 text-fg"
            placeholder="Ví dụ: Quán cà phê"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setKind("static")}
            className={`h-11 rounded-lg border text-sm ${kind === "static" ? "border-primary bg-surface-2" : "border-border"}`}
          >
            Web tĩnh
          </button>
          <button
            type="button"
            onClick={() => setKind("dynamic")}
            className={`h-11 rounded-lg border text-sm ${kind === "dynamic" ? "border-primary bg-surface-2" : "border-border"}`}
          >
            App động
          </button>
        </div>
        {kind === "static" ? (
          <label className="grid gap-1 text-sm">
            Nguồn
            <select
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              className="h-11 rounded-lg border border-border bg-bg px-3"
            >
              <option value="pioneer">Mẫu Pioneer</option>
              <option value="pi-network">Pi Network · SoloHost</option>
              <option value="blank">Trang trống</option>
              <option value="paste">Dán HTML</option>
              <option value="zip">Tải ZIP</option>
            </select>
          </label>
        ) : (
          <label className="grid gap-1 text-sm">
            Runtime child process
            <select
              value={runtime}
              onChange={(event) => setRuntime(event.target.value === "python" ? "python" : "node")}
              className="h-11 rounded-lg border border-border bg-bg px-3"
            >
              <option value="node">Node.js beacon</option>
              <option value="python">Python beacon</option>
            </select>
          </label>
        )}
        {kind === "static" && template === "paste" ? (
          <label className="grid gap-1 text-sm">
            HTML
            <textarea
              required
              value={html}
              onChange={(event) => setHtml(event.target.value)}
              className="min-h-28 rounded-lg border border-border bg-bg p-3 font-mono text-xs"
              placeholder="<!doctype html>"
            />
          </label>
        ) : null}
        {kind === "static" && template === "zip" ? (
          <label className="grid gap-1 text-sm">
            ZIP có index.html
            <input
              type="file"
              accept=".zip,application/zip"
              className="h-11 text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 1_500_000) {
                  setZipName("Tệp quá 1.5MB");
                  setZipBase64(undefined);
                  return;
                }
                void fileToBase64(file).then((value) => {
                  setZipBase64(value);
                  setZipName(file.name);
                });
              }}
            />
            {zipName ? <span className="font-mono text-xs text-muted">{zipName}</span> : null}
          </label>
        ) : null}
        <button
          type="submit"
          disabled={busy || (template === "zip" && kind === "static" && !zipBase64)}
          className="h-11 rounded-lg bg-primary text-sm font-semibold text-primary-fg disabled:opacity-50"
        >
          {busy ? "Đang ghi sổ…" : "Ghi vào Hub"}
        </button>
      </div>
    </form>
  );
}

function LogPanel({
  apps,
  selected,
  lines,
  termRef,
  onSelect,
}: {
  apps: AppView[];
  selected: string | null;
  lines: LogLine[];
  termRef: RefObject<HTMLPreElement | null>;
  onSelect: (id: string) => void;
}) {
  const current = apps.find((app) => app.id === selected);
  return (
    <section className="rounded-lg border border-border bg-surface" aria-label="Nhật ký thời gian thực">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Radio aria-hidden="true" className="size-4 text-primary" />
          Terminal
        </h2>
        <select
          value={selected ?? ""}
          onChange={(event) => onSelect(event.target.value)}
          className="h-11 max-w-48 rounded-lg border border-border bg-bg px-2 text-sm"
          aria-label="Chọn ứng dụng"
        >
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </div>
      <p className="px-3 pt-3 font-mono text-xs text-muted">
        {current ? `${current.supervisor} · ${current.domain}` : "Chọn một app"}
      </p>
      <pre
        ref={termRef}
        className="mx-3 mb-3 mt-2 h-96 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-muted">Chờ stdout/stderr…</span>
        ) : (
          lines.map((line, index) => (
            <span
              key={`${line.ts}-${index}`}
              className={`block ${line.stream === "stderr" ? "text-alert" : line.stream === "sys" ? "text-primary" : "text-fg"}`}
            >
              {formatTime(line.ts)} {line.stream} {line.text}
            </span>
          ))
        )}
      </pre>
    </section>
  );
}

function LedgerPanel({ snap }: { snap: HubSnapshot | null }) {
  const blocks = useMemo(() => [...(snap?.blocks ?? [])].reverse(), [snap]);
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-label="Sổ cái">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Chuỗi cấu hình</h2>
        <p className="font-mono text-xs text-muted">{snap?.chain.valid ? "hợp lệ" : snap ? "gãy" : "…"}</p>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-muted">đỉnh {snap?.chain.tip.slice(0, 24) ?? "—"}</p>
      <ol className="mt-4 flex flex-col gap-3">
        {blocks.map((block) => (
          <li key={block.hash} className="rounded-lg border border-border bg-bg p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-xs tabular-nums text-primary">#{block.index}</p>
              <p className="font-mono text-xs text-muted">{block.validSig ? "chữ ký OK" : "chữ ký lỗi"}</p>
            </div>
            <p className="mt-2 text-sm">{block.summary}</p>
            <p className="mt-1 text-xs text-muted">
              {block.signerName} · {formatTime(block.timestamp)}
            </p>
            <p className="mt-2 break-all font-mono text-xs text-muted">{block.hash}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MeshPanel({
  snap,
  busy,
  onOp,
}: {
  snap: HubSnapshot | null;
  busy: string | null;
  onOp: (op: "peer-deploy" | "resync" | "bad-block") => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-label="Mạng peer">
      <h2 className="text-sm font-semibold">Ba hub, một chuỗi</h2>
      <p className="mt-2 text-pretty text-sm text-muted">
        Trong bản xem trước, ba nút sống chung một tiến trình để ký và gossip thật. Pi-Node-C nhận block chậm hơn
        một nhịp.
      </p>
      <ul className="mt-4 grid gap-3">
        {(snap?.peers ?? []).map((peer) => (
          <li key={peer.id} className="rounded-lg border border-border bg-bg p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{peer.name}</p>
              <p className="font-mono text-xs text-muted">{peer.status}</p>
            </div>
            <p className="mt-2 font-mono text-xs text-muted">
              {peer.role === "local" ? "hub này" : "peer"} · {peer.fingerprint}
            </p>
            <p className="mt-2 font-mono text-xs tabular-nums text-fg">
              cao {peer.height} · {peer.apps} app
            </p>
          </li>
        ))}
      </ul>
      {snap && snap.rejections.length > 0 ? (
        <div className="mt-4 rounded-lg border border-alert bg-bg p-3">
          <p className="text-sm text-alert">Block bị bác</p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted">
            {snap.rejections.map((item) => (
              <li key={item.ts}>
                {formatTime(item.ts)} {item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 grid gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onOp("peer-deploy")}
          className="h-11 rounded-lg bg-primary text-sm font-semibold text-primary-fg disabled:opacity-50"
        >
          Peer B thêm trang dự phòng
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onOp("bad-block")}
          className="h-11 rounded-lg border border-alert text-sm text-alert disabled:opacity-50"
        >
          Thử phát block giả
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onOp("resync")}
          className="h-11 rounded-lg border border-border text-sm disabled:opacity-50"
        >
          Ép đồng bộ chiều cao
        </button>
      </div>
    </section>
  );
}

function FlowPanel({ snap }: { snap: HubSnapshot | null }) {
  const steps = [
    {
      title: "Cổng chính",
      body: "Mọi request vào Hub. Tiến trình con chạy trong cùng container, không tách image riêng.",
    },
    {
      title: "Web tĩnh",
      body: "HTML/CSS/JS nằm trong volume dữ liệu và được phục vụ theo slug, giống virtual host.",
    },
    {
      title: "App động",
      body: "child_process.spawn cấp cổng nội bộ, bắt stdout/stderr/exit và tự restart khi crash. Proxy nội bộ chuyển tiếp request.",
    },
    {
      title: "Sổ cái",
      body: "Mỗi thay đổi là một block SHA-256, ký Ed25519, gossip sang peer. Peer kiểm chữ ký rồi mới nhận bản sao.",
    },
  ];
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-label="Luồng dữ liệu">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldOff aria-hidden="true" className="size-4 text-primary" />
        Luồng trong một Hub
      </h2>
      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-lg border border-border bg-bg p-3">
            <p className="font-mono text-xs text-primary">0{index + 1}</p>
            <p className="mt-1 font-semibold">{step.title}</p>
            <p className="mt-1 text-pretty text-sm text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 font-mono text-xs text-muted">
        dữ liệu {snap?.hub.persistent ? snap.hub.dataDir : "bộ nhớ tiến trình"} · khóa {snap?.hub.fingerprint ?? "—"}
      </p>
    </section>
  );
}


function SystemPanel({
  lang,
  metrics,
  busy,
  onRefreshMetrics,
  onExport,
  onImportFile,
}: {
  lang: Lang;
  metrics: HubMetrics | null;
  busy: string | null;
  onRefreshMetrics: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <HardDrive className="size-4" aria-hidden />
          {lang === "vi" ? "Hệ thống & sao lưu" : "System & backup"}
        </h2>
        <button
          type="button"
          disabled={!!busy}
          onClick={onRefreshMetrics}
          className="h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50"
        >
          {lang === "vi" ? "Làm mới metrics" : "Refresh metrics"}
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted">Apps</dt>
          <dd className="mt-1 text-fg">{metrics ? `${metrics.appsRunning}/${metrics.appsTotal} run` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Crashed</dt>
          <dd className="mt-1 text-fg">{metrics?.appsCrashed ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Chain</dt>
          <dd className="mt-1 text-fg">{metrics ? `#${metrics.chainHeight} ${metrics.chainValid ? "OK" : "BAD"}` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">RSS</dt>
          <dd className="mt-1 text-fg">{metrics?.processRssMb != null ? `${metrics.processRssMb} MB` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Uptime</dt>
          <dd className="mt-1 text-fg">{metrics ? `${metrics.processUptimeSec}s` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Ports</dt>
          <dd className="mt-1 truncate text-fg">{metrics?.portsInUse?.length ? metrics.portsInUse.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Log lines</dt>
          <dd className="mt-1 text-fg">{metrics?.logLines ?? "—"}</dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="text-muted">Data</dt>
          <dd className="mt-1 break-all text-fg">{metrics?.dataDir ?? "—"} · {metrics?.persistent ? "persistent" : "memory"}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-muted">
        {lang === "vi"
          ? "Backup gồm metadata, ledger và khóa identity. Giữ file an toàn. Khôi phục sẽ dừng app động và đặt lại trạng thái stopped."
          : "Backup includes metadata, ledger, and identity keys. Keep the file safe. Restore stops dynamic apps and sets them to stopped."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={onExport}
          className="flex h-11 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg disabled:opacity-50"
        >
          <Download className="size-4" aria-hidden />
          {lang === "vi" ? "Xuất backup" : "Export backup"}
        </button>
        <label className="flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm">
          <Upload className="size-4" aria-hidden />
          {lang === "vi" ? "Nhập backup" : "Import backup"}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

