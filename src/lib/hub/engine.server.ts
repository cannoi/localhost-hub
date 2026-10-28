import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type {
  AppKind,
  AppStatus,
  AppView,
  BlockView,
  DeployInput,
  HubSnapshot,
  LogLine,
  PeerView,
  Rejection,
  Runtime,
  Supervisor,
} from "./types";

type LedgerData =
  | { type: "genesis"; hubId: string; note: string }
  | { type: "app.upsert"; app: PersistedApp }
  | { type: "app.status"; id: string; status: AppStatus; originHub: string }
  | { type: "app.delete"; id: string; originHub: string };

type Block = {
  index: number;
  timestamp: number;
  data: LedgerData;
  previousHash: string;
  hash: string;
  signature: string;
  signer: string;
};

type PersistedApp = {
  id: string;
  name: string;
  slug: string;
  kind: AppKind;
  status: AppStatus;
  domain: string;
  internalPort: number | null;
  runtime: Runtime;
  template: string;
  restarts: number;
  lastError?: string;
  createdAt: string;
  originHub: string;
  supervisor: Supervisor;
  html?: string;
  files?: Record<string, string>;
};

type LiveApp = PersistedApp;

type Proc = {
  child?: ChildProcess;
  server?: Server;
  timer?: ReturnType<typeof setInterval>;
  port: number;
  expectExit?: boolean;
};

type KeyRec = {
  id: string;
  name: string;
  role: "local" | "peer";
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  pubPem: string;
  privPem: string;
};

type PeerRuntime = {
  id: string;
  name: string;
  role: "local" | "peer";
  height: number;
  status: PeerView["status"];
  apps: Map<string, PersistedApp>;
};

type Engine = {
  schema: 1;
  dataDir: string;
  persistent: boolean;
  keys: KeyRec[];
  chain: Block[];
  apps: Map<string, LiveApp>;
  mirrors: Map<string, LiveApp>;
  peers: PeerRuntime[];
  logs: Map<string, LogLine[]>;
  listeners: Map<string, Set<(line: LogLine) => void>>;
  procs: Map<string, Proc>;
  gens: Map<string, number>;
  inflight: Set<string>;
  rejections: Rejection[];
  ready: boolean;
};

const ZERO = "0".repeat(64);
const MAX_APPS = 8;
const MAX_RESTARTS = 5;
const SCHEMA = 1;

const g = globalThis as typeof globalThis & { __OFIE_HUB__?: Engine };

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(",")}}`;
}

function hashBlock(block: Pick<Block, "index" | "timestamp" | "data" | "previousHash">): string {
  const payload = `${block.index}|${block.timestamp}|${stable(block.data)}|${block.previousHash}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function signHash(hash: string, key: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(hash), key).toString("base64");
}

function verifyHash(hash: string, signature: string, key: crypto.KeyObject): boolean {
  try {
    return crypto.verify(null, Buffer.from(hash), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function fingerprint(pem: string): string {
  return crypto.createHash("sha256").update(pem).digest("hex").slice(0, 12);
}

function makeKey(id: string, name: string, role: KeyRec["role"]): KeyRec {
  const pair = crypto.generateKeyPairSync("ed25519");
  const pubPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { id, name, role, publicKey: pair.publicKey, privateKey: pair.privateKey, pubPem, privPem };
}

function keyFromPem(saved: { id: string; name: string; role: KeyRec["role"]; pubPem: string; privPem: string }): KeyRec {
  return {
    ...saved,
    publicKey: crypto.createPublicKey(saved.pubPem),
    privateKey: crypto.createPrivateKey(saved.privPem),
  };
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "app";
}

function localKey(engine: Engine): KeyRec {
  const key = engine.keys.find((item) => item.role === "local");
  if (!key) throw new Error("thiếu khóa hub");
  return key;
}

function keyById(engine: Engine, id: string): KeyRec | undefined {
  return engine.keys.find((item) => item.id === id);
}

function hubName(engine: Engine, id: string): string {
  return keyById(engine, id)?.name ?? id.slice(0, 8);
}

function dataDir(): string {
  return process.env.HUB_DATA_DIR || join(process.cwd(), "data", "ofie-hub");
}

function statePath(dir: string): string {
  return join(dir, "state.json");
}

function pidPath(dir: string): string {
  return join(dir, "pids.json");
}

function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function killStale(dir: string) {
  const file = pidPath(dir);
  if (!existsSync(file)) return;
  try {
    const pids = JSON.parse(readFileSync(file, "utf8")) as number[];
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* ignore corrupt pid file */
  }
  try {
    writeFileSync(file, "[]");
  } catch {
    /* ignore */
  }
}

function rememberPid(engine: Engine, pid: number) {
  const file = pidPath(engine.dataDir);
  let pids: number[] = [];
  try {
    pids = JSON.parse(readFileSync(file, "utf8")) as number[];
  } catch {
    pids = [];
  }
  pids.push(pid);
  try {
    writeFileSync(file, JSON.stringify([...new Set(pids)]));
  } catch {
    engine.persistent = false;
  }
}

function forgetPid(engine: Engine, pid: number) {
  try {
    const pids = JSON.parse(readFileSync(pidPath(engine.dataDir), "utf8")) as number[];
    writeFileSync(pidPath(engine.dataDir), JSON.stringify(pids.filter((item) => item !== pid)));
  } catch {
    /* ignore */
  }
}

function persist(engine: Engine) {
  const body = {
    schema: SCHEMA,
    keys: engine.keys.map((key) => ({
      id: key.id,
      name: key.name,
      role: key.role,
      pubPem: key.pubPem,
      privPem: key.privPem,
    })),
    chain: engine.chain,
    apps: [...engine.apps.values()],
    mirrors: [...engine.mirrors.values()],
  };
  try {
    writeFileSync(statePath(engine.dataDir), JSON.stringify(body));
    engine.persistent = true;
  } catch {
    engine.persistent = false;
  }
}

function pushLog(engine: Engine, id: string, stream: LogLine["stream"], text: string) {
  const line: LogLine = { ts: Date.now(), stream, text: text.slice(0, 500) };
  const list = engine.logs.get(id) ?? [];
  list.push(line);
  if (list.length > 200) list.splice(0, list.length - 200);
  engine.logs.set(id, list);
  const subs = engine.listeners.get(id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(line);
    } catch {
      /* listener must not break the hub */
    }
  }
}

function toView(engine: Engine, app: LiveApp): AppView {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    kind: app.kind,
    status: app.status,
    domain: app.domain,
    internalPort: app.internalPort,
    runtime: app.runtime,
    template: app.template,
    restarts: app.restarts,
    lastError: app.lastError,
    createdAt: app.createdAt,
    originHub: app.originHub,
    originName: hubName(engine, app.originHub),
    supervisor: app.supervisor,
  };
}

function summarize(data: LedgerData): string {
  if (data.type === "genesis") return "Khối khởi tạo sổ cái";
  if (data.type === "app.upsert") return `Ghi ${data.app.name}`;
  if (data.type === "app.status") return `Trạng thái → ${data.status}`;
  return "Xóa ứng dụng";
}

function blockView(engine: Engine, block: Block): BlockView {
  const key = keyById(engine, block.signer);
  const validSig = key ? verifyHash(block.hash, block.signature, key.publicKey) : false;
  return {
    index: block.index,
    timestamp: block.timestamp,
    summary: summarize(block.data),
    hash: block.hash,
    previousHash: block.previousHash,
    signer: block.signer,
    signerName: hubName(engine, block.signer),
    signature: block.signature,
    validSig,
  };
}

function chainValid(engine: Engine): boolean {
  for (let i = 0; i < engine.chain.length; i += 1) {
    const block = engine.chain[i];
    if (!block || block.index !== i) return false;
    const prev = i === 0 ? ZERO : engine.chain[i - 1]?.hash;
    if (block.previousHash !== prev) return false;
    if (hashBlock(block) !== block.hash) return false;
    const key = keyById(engine, block.signer);
    if (!key || !verifyHash(block.hash, block.signature, key.publicKey)) return false;
  }
  return engine.chain.length > 0;
}

function rejectReason(engine: Engine, block: Block): string | null {
  const tip = engine.chain[engine.chain.length - 1];
  if (!tip) return "chuỗi rỗng";
  if (block.index !== tip.index + 1) return "index không nối tiếp";
  if (block.previousHash !== tip.hash) return "previousHash không khớp đỉnh chuỗi";
  if (hashBlock(block) !== block.hash) return "SHA-256 không khớp nội dung khối";
  const key = keyById(engine, block.signer);
  if (!key) return "signer không thuộc consortium";
  if (!verifyHash(block.hash, block.signature, key.publicKey)) return "chữ ký Ed25519 không hợp lệ";
  return null;
}

function applyRegistry(engine: Engine, target: PeerRuntime, block: Block) {
  const data = block.data;
  if (data.type === "genesis") return;
  if (data.type === "app.delete") {
    target.apps.delete(data.id);
    if (target.role === "local") engine.mirrors.delete(data.id);
    return;
  }
  if (data.type === "app.status") {
    const local = target.role === "local" ? engine.apps.get(data.id) : undefined;
    if (local && local.originHub === engine.keys.find((k) => k.role === "local")?.id) {
      local.status = data.status;
      return;
    }
    const mirror = target.apps.get(data.id);
    if (mirror) mirror.status = data.status === "running" ? "standby" : data.status;
    if (target.role === "local") {
      const held = engine.mirrors.get(data.id);
      if (held) held.status = data.status === "running" ? "standby" : data.status;
    }
    return;
  }
  const copy: PersistedApp = { ...data.app, files: data.app.files ? { ...data.app.files } : undefined };
  const localId = localKey(engine).id;
  if (target.role === "local" && copy.originHub === localId) {
    if (!engine.apps.has(copy.id)) engine.apps.set(copy.id, copy);
    return;
  }
  copy.supervisor = "mirror";
  copy.internalPort = null;
  if (copy.status === "running" || copy.status === "starting") copy.status = "standby";
  target.apps.set(copy.id, copy);
  if (target.role === "local") engine.mirrors.set(copy.id, copy);
}

function snapshotData(data: LedgerData): LedgerData {
  return JSON.parse(JSON.stringify(data)) as LedgerData;
}

function appendBlock(engine: Engine, data: LedgerData, signerId: string) {
  const signer = keyById(engine, signerId);
  if (!signer) throw new Error("không có khóa ký");
  const tip = engine.chain[engine.chain.length - 1];
  if (!tip) throw new Error("thiếu genesis");
  const partial = {
    index: tip.index + 1,
    timestamp: Date.now(),
    data: snapshotData(data),
    previousHash: tip.hash,
  };
  const hash = hashBlock(partial);
  const block: Block = { ...partial, hash, signature: signHash(hash, signer.privateKey), signer: signerId };
  const reason = rejectReason(engine, block);
  if (reason) throw new Error(reason);
  engine.chain.push(block);
  for (const peer of engine.peers) {
    if (peer.id === "peer-c") {
      peer.status = "syncing";
      setTimeout(() => {
        const known = peer.height;
        for (const item of engine.chain) {
          if (item.index > known) applyRegistry(engine, peer, item);
        }
        peer.height = engine.chain[engine.chain.length - 1]?.index ?? peer.height;
        peer.status = "synced";
      }, 800);
      continue;
    }
    applyRegistry(engine, peer, block);
    peer.height = block.index;
    peer.status = "synced";
  }
  persist(engine);
  return block;
}

function seedApps(engine: Engine) {
  const local = localKey(engine);
  const landing = makeStatic(engine, {
    name: "Cổng Pioneer",
    template: "pioneer",
    html: pioneerHtml(),
  });
  engine.apps.set(landing.id, landing);
  pushLog(engine, landing.id, "sys", "Vhost tĩnh đã gắn. Không spawn tiến trình.");
  appendBlock(engine, { type: "app.upsert", app: landing }, local.id);

  const beacon = makeDynamic(engine, { name: "Beacon Node", runtime: "node", template: "beacon-node" });
  engine.apps.set(beacon.id, beacon);
  appendBlock(engine, { type: "app.upsert", app: beacon }, local.id);
  void startApp(engine, beacon.id)
    .then(() => {
      try {
        appendBlock(
          engine,
          { type: "app.status", id: beacon.id, status: beacon.status, originHub: beacon.originHub },
          local.id,
        );
      } catch (error) {
        pushLog(engine, beacon.id, "stderr", error instanceof Error ? error.message : "không ghi được trạng thái");
      }
    })
    .catch((error: unknown) => {
      beacon.status = "crashed";
      beacon.lastError = error instanceof Error ? error.message : "không khởi động được";
      pushLog(engine, beacon.id, "stderr", beacon.lastError);
    });
}

function loadOrCreate(): Engine {
  const dir = dataDir();
  const writable = ensureDir(dir);
  if (writable) killStale(dir);
  const engine: Engine = {
    schema: 1,
    dataDir: dir,
    persistent: writable,
    keys: [],
    chain: [],
    apps: new Map(),
    mirrors: new Map(),
    peers: [],
    logs: new Map(),
    listeners: new Map(),
    procs: new Map(),
    gens: new Map(),
    inflight: new Set(),
    rejections: [],
    ready: false,
  };

  let saved: {
    schema?: number;
    keys?: Array<{ id: string; name: string; role: KeyRec["role"]; pubPem: string; privPem: string }>;
    chain?: Block[];
    apps?: PersistedApp[];
    mirrors?: PersistedApp[];
  } | null = null;
  if (writable && existsSync(statePath(dir))) {
    try {
      saved = JSON.parse(readFileSync(statePath(dir), "utf8")) as typeof saved;
    } catch {
      saved = null;
    }
  }

  let restored = false;
  if (saved?.schema === SCHEMA && saved.keys && saved.chain && saved.keys.length === 3) {
    engine.keys = saved.keys.map((key) => keyFromPem(key));
    engine.chain = saved.chain;
    if (chainValid(engine)) {
      restored = true;
      for (const app of saved.apps ?? []) {
        if (app.kind === "dynamic") {
          app.status = app.status === "standby" ? "standby" : "stopped";
          app.internalPort = null;
        }
        engine.apps.set(app.id, app);
        pushLog(engine, app.id, "sys", "Khôi phục từ đĩa. App động cần bấm Start lại.");
      }
      for (const app of saved.mirrors ?? []) engine.mirrors.set(app.id, app);
    } else {
      engine.keys = [];
      engine.chain = [];
    }
  }
  if (!restored) {
    engine.apps.clear();
    engine.mirrors.clear();
    engine.keys = [
      makeKey("hub-local", "Ofie Local", "local"),
      makeKey("peer-b", "Pi-Node-B", "peer"),
      makeKey("peer-c", "Pi-Node-C", "peer"),
    ];
    const local = localKey(engine);
    const genesisPartial = {
      index: 0,
      timestamp: Date.now(),
      data: { type: "genesis" as const, hubId: local.id, note: "Ofie consortium ledger" },
      previousHash: ZERO,
    };
    const hash = hashBlock(genesisPartial);
    engine.chain = [
      {
        ...genesisPartial,
        hash,
        signature: signHash(hash, local.privateKey),
        signer: local.id,
      },
    ];
  }

  engine.peers = engine.keys.map((key) => ({
    id: key.id,
    name: key.name,
    role: key.role,
    height: engine.chain[engine.chain.length - 1]?.index ?? 0,
    status: "synced" as const,
    apps: new Map(key.role === "local" ? engine.apps : []),
  }));
  if (!restored) seedApps(engine);
  else {
    for (const peer of engine.peers) {
      if (peer.role !== "local") {
        for (const block of engine.chain) applyRegistry(engine, peer, block);
      }
    }
  }
  engine.ready = true;
  persist(engine);
  return engine;
}

export function getHub(): Engine {
  if (!g.__OFIE_HUB__) g.__OFIE_HUB__ = loadOrCreate();
  return g.__OFIE_HUB__;
}

function uniqueSlug(engine: Engine, name: string): string {
  const base = slugify(name);
  const taken = new Set([...engine.apps.values(), ...engine.mirrors.values()].map((app) => app.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 50; n += 1) {
    const next = `${base.slice(0, 36)}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${base.slice(0, 28)}-${crypto.randomBytes(3).toString("hex")}`;
}

function makeStatic(engine: Engine, input: { name: string; template: string; html?: string; files?: Record<string, string> }): LiveApp {
  const local = localKey(engine);
  const slug = uniqueSlug(engine, input.name);
  return {
    id: crypto.randomUUID(),
    name: input.name.trim().slice(0, 48),
    slug,
    kind: "static",
    status: "running",
    domain: `/api/vhost/${slug}/`,
    internalPort: null,
    runtime: "static",
    template: input.template,
    restarts: 0,
    createdAt: new Date().toISOString(),
    originHub: local.id,
    supervisor: "static",
    html: input.html,
    files: input.files,
  };
}

function makeDynamic(engine: Engine, input: { name: string; runtime: "node" | "python"; template: string }): LiveApp {
  const local = localKey(engine);
  const slug = uniqueSlug(engine, input.name);
  return {
    id: crypto.randomUUID(),
    name: input.name.trim().slice(0, 48),
    slug,
    kind: "dynamic",
    status: "stopped",
    domain: `/api/vhost/${slug}/`,
    internalPort: null,
    runtime: input.runtime,
    template: input.template,
    restarts: 0,
    createdAt: new Date().toISOString(),
    originHub: local.id,
    supervisor: "child",
  };
}

function readZip(b64: string): Record<string, string> {
  const buf = Buffer.from(b64, "base64");
  if (buf.length > 1_500_000) throw new Error("ZIP vượt 1.5MB");
  const entries = unzipSync(new Uint8Array(buf));
  const files: Record<string, string> = {};
  let total = 0;
  const allowed = new Set(["html", "css", "js", "txt", "svg", "json", "md"]);
  for (const [rawName, data] of Object.entries(entries)) {
    const norm = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!norm || norm.endsWith("/") || norm.split("/").some((part) => part === ".." || part === "")) continue;
    const ext = norm.split(".").pop()?.toLowerCase() ?? "";
    if (!allowed.has(ext)) continue;
    total += data.byteLength;
    if (total > 2_000_000) throw new Error("Nội dung giải nén quá lớn");
    if (Object.keys(files).length > 40) throw new Error("ZIP quá nhiều tệp");
    files[norm] = new TextDecoder().decode(data);
  }
  const hasIndex = Object.keys(files).some((name) => name === "index.html" || name.endsWith("/index.html"));
  if (!hasIndex) throw new Error("ZIP cần có index.html");
  return files;
}

export function deployApp(input: DeployInput): { ok: true; app: AppView } | { ok: false; error: string } {
  try {
    const engine = getHub();
    const name = input.name?.trim() ?? "";
    if (name.length < 2) return { ok: false, error: "Tên ứng dụng cần ít nhất 2 ký tự." };
    if (engine.apps.size >= MAX_APPS) return { ok: false, error: "Hub đã đủ 8 ứng dụng cục bộ." };
    let app: LiveApp;
    if (input.kind === "static") {
      let html = input.html?.slice(0, 80_000);
      let files: Record<string, string> | undefined;
      let template = input.template || "blank";
      if (input.zipBase64) {
        files = readZip(input.zipBase64);
        template = "zip";
        html = undefined;
      } else if (!html) {
        html = template === "pioneer" ? pioneerHtml() : template === "pi-network" ? piNetworkHtml(name) : blankHtml(name);
        template = template === "pioneer" ? "pioneer" : template === "pi-network" ? "pi-network" : "blank";
      } else {
        template = "paste";
      }
      app = makeStatic(engine, { name, template, html, files });
      engine.apps.set(app.id, app);
      writeStaticFiles(engine, app);
      pushLog(engine, app.id, "sys", `Static vhost ${app.domain} đã phục vụ từ bộ nhớ Hub.`);
    } else {
      const runtime = input.runtime === "python" ? "python" : "node";
      app = makeDynamic(engine, {
        name,
        runtime,
        template: runtime === "python" ? "beacon-python" : "beacon-node",
      });
      engine.apps.set(app.id, app);
      pushLog(engine, app.id, "sys", "Đã ghi sổ. Bấm Start để spawn child process.");
    }
    appendBlock(engine, { type: "app.upsert", app: cloneApp(app) }, localKey(engine).id);
    return { ok: true, app: toView(engine, app) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "không deploy được" };
  }
}

function cloneApp(app: LiveApp): PersistedApp {
  return { ...app, files: app.files ? { ...app.files } : undefined };
}

export async function actApp(
  id: string,
  op: "start" | "stop" | "restart" | "delete" | "activate",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const engine = getHub();
    if (op === "activate") return activateMirror(engine, id);
    const app = engine.apps.get(id);
    if (!app) return { ok: false, error: "Không thấy ứng dụng." };
    if (op === "delete") {
      await stopApp(engine, id, false);
      engine.apps.delete(id);
      engine.logs.delete(id);
      try {
        rmSync(join(engine.dataDir, "apps", app.slug), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      appendBlock(engine, { type: "app.delete", id, originHub: app.originHub }, localKey(engine).id);
      return { ok: true };
    }
    if (op === "stop") {
      await stopApp(engine, id, true);
      appendBlock(
        engine,
        { type: "app.status", id, status: "stopped", originHub: app.originHub },
        localKey(engine).id,
      );
      return { ok: true };
    }
    if (op === "restart") {
      await stopApp(engine, id, false);
      app.restarts = 0;
      await startApp(engine, id);
      appendBlock(
        engine,
        { type: "app.status", id, status: app.status, originHub: app.originHub },
        localKey(engine).id,
      );
      return { ok: true };
    }
    await startApp(engine, id);
    appendBlock(
      engine,
      { type: "app.status", id, status: app.status, originHub: app.originHub },
      localKey(engine).id,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "thao tác thất bại" };
  }
}

function activateMirror(engine: Engine, id: string): { ok: true } | { ok: false; error: string } {
  const mirror = engine.mirrors.get(id);
  if (!mirror) return { ok: false, error: "Không có bản sao dự phòng." };
  if (engine.apps.has(id)) return { ok: false, error: "App đã có trên hub này." };
  if (engine.apps.size >= MAX_APPS) return { ok: false, error: "Hub đã đủ 8 ứng dụng cục bộ." };
  const local = localKey(engine);
  const app: LiveApp = {
    ...cloneApp(mirror),
    originHub: local.id,
    status: mirror.kind === "static" ? "running" : "stopped",
    supervisor: mirror.kind === "static" ? "static" : "child",
    internalPort: null,
    restarts: 0,
    domain: `/api/vhost/${mirror.slug}/`,
  };
  engine.apps.set(app.id, app);
  engine.mirrors.delete(id);
  if (app.kind === "static") {
    writeStaticFiles(engine, app);
    pushLog(engine, app.id, "sys", "Failover: vhost tĩnh đã kích hoạt trên hub này.");
  } else {
    pushLog(engine, app.id, "sys", "Failover: app động đã nhận. Bấm Start để spawn.");
  }
  appendBlock(engine, { type: "app.upsert", app: cloneApp(app) }, local.id);
  return { ok: true };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("không cấp được cổng nội bộ");
  return port;
}

async function waitForPort(port: number): Promise<boolean> {
  for (let i = 0; i < 25; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

function nodeSource(): string {
  return `const http = require("http");
const port = Number(process.env.PORT);
const name = process.env.APP_NAME || "app";
let n = 0;
setInterval(() => {
  n += 1;
  console.log("[beacon] " + name + " heartbeat #" + n + " pid=" + process.pid);
}, 2000);
const server = http.createServer((req, res) => {
  const body = "<!doctype html><meta charset=utf-8><title>" + name +
    "</title><body style=\\"margin:0;background:#101614;color:#e8efe9;font-family:sans-serif\\"><main style=\\"padding:28px\\"><p style=\\"letter-spacing:.14em;color:#d7a441;font-size:12px\\">DYNAMIC CHILD</p><h1>" +
    name + "</h1><p>Tiến trình Node riêng, cổng nội bộ " + port + ".</p><p id=t></p></main><script>setInterval(()=>{document.getElementById('t').textContent=new Date().toISOString()},500)</script>";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
server.listen(port, "127.0.0.1");
`;
}

function pythonSource(): string {
  return `import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port = int(os.environ["PORT"])
name = os.environ.get("APP_NAME", "app")
print(f"[beacon] {name} python pid={os.getpid()} port={port}", flush=True)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("<!doctype html><meta charset=utf-8><title>" + name +
          "</title><body style='margin:0;background:#101614;color:#e8efe9;font-family:sans-serif'><main style='padding:28px'><p style='color:#d7a441;letter-spacing:.14em;font-size:12px'>PYTHON CHILD</p><h1>" +
          name + "</h1><p>Tiến trình Python riêng, cổng nội bộ " + str(port) + ".</p></main>").encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        print("[access] " + (fmt % args), flush=True)
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
`;
}

function wireChild(engine: Engine, app: LiveApp, child: ChildProcess, gen: number) {
  const pid = child.pid;
  if (pid) rememberPid(engine, pid);
  const onChunk = (stream: LogLine["stream"]) => (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) pushLog(engine, app.id, stream, line);
    }
  };
  child.stdout?.on("data", onChunk("stdout"));
  child.stderr?.on("data", onChunk("stderr"));
  child.on("error", (error) => {
    pushLog(engine, app.id, "stderr", error.message);
    app.lastError = error.message;
  });
  child.on("exit", (code, signal) => {
    if (pid) forgetPid(engine, pid);
    const current = engine.procs.get(app.id);
    const expected = current?.expectExit === true;
    if (current?.child === child) engine.procs.delete(app.id);
    if (expected || engine.inflight.has(app.id) || engine.gens.get(app.id) !== gen) {
      if (!expected && engine.inflight.has(app.id)) {
        pushLog(engine, app.id, "stderr", `Child thoát khi đang khởi động (code=${code ?? "null"})`);
      }
      return;
    }
    pushLog(engine, app.id, "stderr", `Thoát code=${code ?? "null"} signal=${signal ?? "none"}`);
    if (app.restarts < MAX_RESTARTS) {
      app.restarts += 1;
      app.status = "starting";
      pushLog(engine, app.id, "sys", `Tự restart lần ${app.restarts}/${MAX_RESTARTS}`);
      setTimeout(() => {
        if (engine.gens.get(app.id) !== gen) return;
        void startApp(engine, app.id).catch(() => undefined);
      }, 800);
      return;
    }
    app.status = "crashed";
    app.internalPort = null;
    app.lastError = "Vượt ngưỡng tự restart";
    try {
      appendBlock(
        engine,
        { type: "app.status", id: app.id, status: "crashed", originHub: app.originHub },
        localKey(engine).id,
      );
    } catch {
      /* ledger must not take down the hub */
    }
  });
}

async function startInProcess(engine: Engine, app: LiveApp, gen: number) {
  const portHolder = { port: 0 };
  let ticks = 0;
  const server = createServer((req, res) => {
    const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(app.name)}</title><body style="margin:0;background:#101614;color:#e8efe9;font-family:sans-serif"><main style="padding:28px"><p style="color:#d7a441;letter-spacing:.14em;font-size:12px">IN-PROCESS FALLBACK</p><h1>${escapeHtml(app.name)}</h1><p>Child process không spawn được. Hub vẫn phục vụ app trên cổng nội bộ ${portHolder.port}.</p><p>${escapeHtml(req.url || "/")}</p></main>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  portHolder.port = port;
  const timer = setInterval(() => {
    ticks += 1;
    pushLog(engine, app.id, "stdout", `[beacon] ${app.name} in-process heartbeat #${ticks}`);
  }, 2000);
  engine.procs.set(app.id, { server, timer, port });
  app.supervisor = "inprocess";
  app.internalPort = port;
  app.status = "running";
  app.lastError = "child_process bị chặn — đang chạy fallback trong Hub";
  pushLog(engine, app.id, "sys", `Fallback in-process tại cổng ${port}.`);
  if (engine.gens.get(app.id) !== gen) {
    await stopApp(engine, app.id, false);
  }
}

async function startApp(engine: Engine, id: string) {
  const app = engine.apps.get(id);
  if (!app) throw new Error("không thấy app");
  if (app.kind === "static") {
    app.status = "running";
    app.supervisor = "static";
    pushLog(engine, app.id, "sys", "Web tĩnh không cần tiến trình. Vhost đang mở.");
    return;
  }
  if (engine.inflight.has(id)) return;
  engine.inflight.add(id);
  try {
    await bootDynamic(engine, app);
  } finally {
    engine.inflight.delete(id);
  }
}

async function bootDynamic(engine: Engine, app: LiveApp) {
  const id = app.id;
  const gen = (engine.gens.get(id) ?? 0) + 1;
  engine.gens.set(id, gen);
  await stopApp(engine, id, false);
  engine.gens.set(id, gen);
  app.status = "starting";
  app.lastError = undefined;
  const port = await reservePort();
  const folder = join(engine.dataDir, "apps", app.slug);
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    /* fall through to in-process */
  }
  const runtime = app.runtime === "python" ? "python" : "node";
  const file = runtime === "python" ? join(folder, "main.py") : join(folder, "server.cjs");
  try {
    writeFileSync(file, runtime === "python" ? pythonSource() : nodeSource());
  } catch (error) {
    pushLog(engine, id, "stderr", error instanceof Error ? error.message : "không ghi được mã nguồn");
    await startInProcess(engine, app, gen);
    return;
  }
  const cmd = runtime === "python" ? "python3" : process.execPath;
  const args = [file];
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      cwd: folder,
      env: { ...process.env, PORT: String(port), APP_NAME: app.name, APP_SLUG: app.slug },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } catch (error) {
    pushLog(engine, id, "stderr", error instanceof Error ? error.message : "spawn lỗi");
    await startInProcess(engine, app, gen);
    return;
  }
  engine.procs.set(id, { child, port });
  app.internalPort = port;
  app.supervisor = "child";
  wireChild(engine, app, child, gen);
  pushLog(engine, id, "sys", `spawn ${runtime} pid=${child.pid ?? "?"} cổng ${port}`);
  const up = await waitForPort(port);
  if (engine.gens.get(id) !== gen) return;
  if (!up || child.exitCode !== null) {
    pushLog(engine, id, "stderr", "Child không nghe cổng. Chuyển fallback in-process.");
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await startInProcess(engine, app, gen);
    return;
  }
  app.status = "running";
  pushLog(engine, id, "sys", `Running trên 127.0.0.1:${port}`);
}

async function stopApp(engine: Engine, id: string, markStopped: boolean) {
  const app = engine.apps.get(id);
  const gen = (engine.gens.get(id) ?? 0) + 1;
  engine.gens.set(id, gen);
  const proc = engine.procs.get(id);
  if (app && markStopped) app.status = "stopped";
  if (!proc) {
    if (app && markStopped) app.internalPort = null;
    return;
  }
  if (proc.timer) clearInterval(proc.timer);
  if (proc.server) {
    await new Promise<void>((resolve) => proc.server?.close(() => resolve()));
  }
  if (proc.child && proc.child.exitCode === null) {
    proc.expectExit = true;
    const child = proc.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1200);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  engine.procs.delete(id);
  if (app && markStopped) {
    app.internalPort = null;
    pushLog(engine, id, "sys", "Stop đã hoàn tất.");
  }
}

function writeStaticFiles(engine: Engine, app: LiveApp) {
  const folder = join(engine.dataDir, "sites", app.slug);
  try {
    mkdirSync(folder, { recursive: true });
    if (app.files) {
      for (const [name, body] of Object.entries(app.files)) {
        const target = join(folder, name);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, body);
      }
    } else if (app.html) {
      writeFileSync(join(folder, "index.html"), app.html);
    }
  } catch {
    pushLog(engine, app.id, "sys", "Không ghi được thư mục site. Vẫn phục vụ từ bộ nhớ.");
  }
}

function contentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".txt") || file.endsWith(".md")) return "text/plain; charset=utf-8";
  return "text/html; charset=utf-8";
}

function lookupFile(files: Record<string, string>, rel: string): { body: string; type: string } | null {
  let path = rel.replace(/^\/+/, "");
  if (!path || path.endsWith("/")) path += "index.html";
  const direct = files[path];
  if (direct !== undefined) return { body: direct, type: contentType(path) };
  const nested = Object.keys(files).find((name) => name.endsWith(`/${path}`));
  if (!nested) return null;
  const body = files[nested];
  if (body === undefined) return null;
  return { body, type: contentType(nested) };
}

function sandboxed(body: string, type: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "content-security-policy": "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
      "cache-control": "no-store",
      "x-ofie-proxy": "hub",
    },
  });
}

export async function serveVhost(pathname: string): Promise<Response> {
  const engine = getHub();
  const match = pathname.match(/\/api\/vhost\/([^/]+)\/?(.*)$/);
  if (!match) return sandboxed("not found", "text/plain; charset=utf-8", 404);
  const slug = decodeURIComponent(match[1] || "");
  const rest = match[2] || "";
  const app =
    [...engine.apps.values()].find((item) => item.slug === slug) ??
    [...engine.mirrors.values()].find((item) => item.slug === slug);
  if (!app) return sandboxed("ứng dụng không tồn tại", "text/plain; charset=utf-8", 404);
  if (app.supervisor === "mirror" || app.status === "standby") {
    if (app.files) {
      const file = lookupFile(app.files, rest);
      if (!file) return sandboxed("không có tệp", "text/plain; charset=utf-8", 404);
      return sandboxed(file.body, file.type);
    }
    return sandboxed(app.html || failoverHtml(), "text/html; charset=utf-8");
  }
  if (app.status !== "running" && app.status !== "starting") {
    return sandboxed(`${app.name} đang ${app.status}`, "text/plain; charset=utf-8", 503);
  }
  if (app.kind === "static") {
    if (app.files) {
      const file = lookupFile(app.files, rest);
      if (!file) return sandboxed("không có tệp", "text/plain; charset=utf-8", 404);
      return sandboxed(file.body, file.type);
    }
    return sandboxed(app.html || blankHtml(app.name), "text/html; charset=utf-8");
  }
  if (!app.internalPort) return sandboxed("chưa có cổng nội bộ", "text/plain; charset=utf-8", 503);
  const targetPath = `/${rest}`.replace(/\/{2,}/g, "/");
  try {
    const upstream = await fetch(`http://127.0.0.1:${app.internalPort}${targetPath}`, {
      signal: AbortSignal.timeout(8000),
    });
    const buf = await upstream.arrayBuffer();
    const type = upstream.headers.get("content-type") || "text/html; charset=utf-8";
    return sandboxed(new TextDecoder().decode(buf), type, upstream.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "proxy lỗi";
    pushLog(engine, app.id, "stderr", `proxy: ${message}`);
    return sandboxed("reverse proxy không tới được cổng nội bộ", "text/plain; charset=utf-8", 502);
  }
}

export function snapshot(): HubSnapshot {
  const engine = getHub();
  const local = localKey(engine);
  const tip = engine.chain[engine.chain.length - 1];
  const peers: PeerView[] = engine.peers.map((peer) => ({
    id: peer.id,
    name: peer.name,
    role: peer.role,
    fingerprint: fingerprint(keyById(engine, peer.id)?.pubPem ?? ""),
    height: peer.role === "local" ? (tip?.index ?? 0) : peer.height,
    status: peer.status,
    apps: peer.role === "local" ? engine.apps.size : peer.apps.size,
  }));
  return {
    hub: {
      id: local.id,
      name: local.name,
      fingerprint: fingerprint(local.pubPem),
      isolated: true,
      dataDir: engine.persistent ? engine.dataDir : "bộ nhớ tiến trình",
      persistent: engine.persistent,
      p2pMode: "simulated-mesh",
    },
    apps: [...engine.apps.values()].map((app) => toView(engine, app)),
    mirrors: [...engine.mirrors.values()].map((app) => toView(engine, app)),
    peers,
    chain: { height: tip?.index ?? 0, valid: chainValid(engine), tip: tip?.hash ?? ZERO },
    blocks: engine.chain.slice(-12).map((block) => blockView(engine, block)),
    rejections: engine.rejections.slice(0, 6),
  };
}

export function logTail(id: string): LogLine[] {
  return getHub().logs.get(id) ?? [];
}

export function subscribeLogs(id: string, fn: (line: LogLine) => void): () => void {
  const engine = getHub();
  const set = engine.listeners.get(id) ?? new Set<(line: LogLine) => void>();
  set.add(fn);
  engine.listeners.set(id, set);
  return () => set.delete(fn);
}

export function meshOp(op: "peer-deploy" | "resync" | "bad-block"): { ok: true; note: string } | { ok: false; error: string } {
  try {
    const engine = getHub();
    if (op === "resync") {
      const tip = engine.chain[engine.chain.length - 1]?.index ?? 0;
      for (const peer of engine.peers) {
        peer.height = tip;
        peer.status = "synced";
      }
      return { ok: true, note: "Các peer đã khớp chiều cao chuỗi." };
    }
    if (op === "bad-block") {
      const tip = engine.chain[engine.chain.length - 1];
      if (!tip) return { ok: false, error: "chuỗi rỗng" };
      const fake: Block = {
        index: tip.index + 1,
        timestamp: Date.now(),
        data: { type: "app.delete", id: "khong-ton-tai", originHub: "peer-b" },
        previousHash: tip.hash,
        hash: "deadbeef".padEnd(64, "0"),
        signature: Buffer.from("not-a-signature").toString("base64"),
        signer: "peer-b",
      };
      const reason = rejectReason(engine, fake) ?? "từ chối";
      engine.rejections.unshift({ ts: Date.now(), reason });
      engine.rejections = engine.rejections.slice(0, 12);
      for (const peer of engine.peers) {
        if (peer.role === "peer") peer.status = "rejected";
      }
      return { ok: true, note: `Đã bác block giả: ${reason}` };
    }
    const peer = keyById(engine, "peer-b");
    if (!peer) return { ok: false, error: "thiếu peer" };
    const slug = `du-phong-${engine.chain.length}`;
    const app: PersistedApp = {
      id: crypto.randomUUID(),
      name: "Trang dự phòng B",
      slug,
      kind: "static",
      status: "running",
      domain: `/api/vhost/${slug}/`,
      internalPort: null,
      runtime: "static",
      template: "failover",
      restarts: 0,
      createdAt: new Date().toISOString(),
      originHub: peer.id,
      supervisor: "static",
      html: failoverHtml(),
    };
    appendBlock(engine, { type: "app.upsert", app }, peer.id);
    return { ok: true, note: "Pi-Node-B đã ký một block. Hub này giữ bản sao dự phòng." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "mesh lỗi" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}

function pioneerHtml(): string {
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cổng Pioneer</title>
<body style="margin:0;background:#101614;color:#e8efe9;font-family:Georgia,serif">
<main style="max-width:40rem;margin:0 auto;padding:2.5rem 1.25rem">
<p style="font-family:ui-monospace,monospace;letter-spacing:.16em;font-size:.75rem;color:#d7a441">STATIC VHOST</p>
<h1 style="font-weight:500;font-size:2.2rem;line-height:1.15">Cổng Pioneer</h1>
<p style="color:#93a39a;line-height:1.55">Trang này được Ofie Hub phục vụ như một site tĩnh. Không có container con — chỉ là tệp HTML trên volume dữ liệu của Hub.</p>
</main>`;
}

function piNetworkHtml(name: string): string {
  const safeName = escapeHtml(name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#20134b"><meta name="description" content="A lightweight Pi Network community page hosted on SoloHost."><title>${safeName} · Pi Network</title>
<style>
:root{color-scheme:dark;--bg:#100b26;--panel:#1b1438;--line:#382c63;--gold:#f5c84c;--text:#f8f6ff;--muted:#c3bbdf}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% 0%,#39216f 0,transparent 42%),var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}a{color:inherit}.wrap{max-width:1040px;margin:auto;padding:24px}.nav{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-weight:750;letter-spacing:.04em}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:var(--gold);color:#24184e;font-size:23px}.lang{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:9px 13px;cursor:pointer}.hero{padding:72px 0 52px;max-width:760px}.eyebrow{color:var(--gold);font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.hero h1{font-size:clamp(38px,7vw,68px);line-height:1.04;letter-spacing:-.045em;margin:16px 0}.hero p{max-width:650px;color:var(--muted);font-size:18px}.pill{display:inline-flex;margin-top:14px;padding:10px 15px;border-radius:999px;background:var(--gold);color:#24184e;text-decoration:none;font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:12px 0 44px}.card{border:1px solid var(--line);background:linear-gradient(145deg,#211945,var(--panel));border-radius:18px;padding:22px}.ico{font-size:25px}.card h2{font-size:17px;margin:12px 0 6px}.card p,footer{color:var(--muted)}footer{border-top:1px solid var(--line);padding:22px 0;font-size:13px}@media(max-width:600px){.wrap{padding:18px}.hero{padding:52px 0 34px}}
</style></head><body><div class="wrap"><header class="nav"><div class="brand"><span class="mark" aria-hidden="true">π</span><span>${safeName}</span></div><button class="lang" id="lang" type="button" aria-label="Switch language">EN / VI</button></header>
<main><section class="hero"><div class="eyebrow" data-en="COMMUNITY · BUILD · CONNECT" data-vi="CỘNG ĐỒNG · XÂY DỰNG · KẾT NỐI">COMMUNITY · BUILD · CONNECT</div><h1 data-en="Build something useful with Pi." data-vi="Cùng Pi xây dựng điều hữu ích.">Build something useful with Pi.</h1><p data-en="A clean, mobile-friendly community landing page hosted on Pi SoloHost. Share your project, explain what you offer, and help visitors find the next step." data-vi="Trang cộng đồng gọn nhẹ, thân thiện với điện thoại và được lưu trữ trên Pi SoloHost. Giới thiệu dự án, chia sẻ giá trị và giúp khách truy cập biết bước tiếp theo.">A clean, mobile-friendly community landing page hosted on Pi SoloHost. Share your project, explain what you offer, and help visitors find the next step.</p><a class="pill" href="#about" data-en="Explore the project ↓" data-vi="Khám phá dự án ↓">Explore the project ↓</a></section>
<section class="grid" id="about"><article class="card"><div class="ico" aria-hidden="true">🌐</div><h2 data-en="Open to everyone" data-vi="Dành cho mọi người">Open to everyone</h2><p data-en="Use this space to introduce your community, service, or idea in clear, friendly language." data-vi="Giới thiệu cộng đồng, dịch vụ hoặc ý tưởng bằng ngôn ngữ rõ ràng, gần gũi.">Use this space to introduce your community, service, or idea in clear, friendly language.</p></article><article class="card"><div class="ico" aria-hidden="true">🛡️</div><h2 data-en="Simple by design" data-vi="Thiết kế tinh gọn">Simple by design</h2><p data-en="A static page: no child container is needed to serve this page." data-vi="Đây là trang tĩnh: không cần container con để phục vụ trang.">A static page: no child container is needed to serve this page.</p></article><article class="card"><div class="ico" aria-hidden="true">📱</div><h2 data-en="Made for mobile" data-vi="Tối ưu cho di động">Made for mobile</h2><p data-en="Responsive layout, accessible controls, and a built-in English / Vietnamese switch." data-vi="Bố cục co giãn, điều khiển dễ tiếp cận và nút chuyển đổi tiếng Anh / tiếng Việt.">Responsive layout, accessible controls, and a built-in English / Vietnamese switch.</p></article></section></main>
<footer><span data-en="Hosted on Pi SoloHost · Customize this template for your project." data-vi="Lưu trữ trên Pi SoloHost · Tùy chỉnh mẫu này theo dự án của bạn.">Hosted on Pi SoloHost · Customize this template for your project.</span></footer></div>
<script>const b=document.getElementById('lang');let lang='en';b.addEventListener('click',()=>{lang=lang==='en'?'vi':'en';document.documentElement.lang=lang;document.querySelectorAll('[data-en][data-vi]').forEach(el=>{el.textContent=el.dataset[lang]});b.setAttribute('aria-label',lang==='en'?'Switch to Vietnamese':'Chuyển sang tiếng Anh')});</script></body></html>`;
}

function blankHtml(name: string): string {
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${escapeHtml(name)}</title><body style="margin:0;background:#101614;color:#e8efe9;font-family:Georgia,serif"><main style="padding:2rem"><h1>${escapeHtml(name)}</h1><p>Site tĩnh mới trên Ofie Hub.</p></main>`;
}

function failoverHtml(): string {
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Dự phòng</title><body style="margin:0;background:#101614;color:#e8efe9;font-family:Georgia,serif"><main style="padding:2rem"><p style="color:#d7a441;font-family:ui-monospace,monospace">FAILOVER COPY</p><h1>Trang dự phòng từ Pi-Node-B</h1><p>Block đã được ký bởi peer và xác thực trên hub này. Bấm kích hoạt nếu hub gốc không còn phục vụ.</p></main>`;
}

export function streamLogs(id: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (line: LogLine) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        } catch {
          /* closed */
        }
      };
      for (const line of logTail(id)) send(line);
      unsubscribe = subscribeLogs(id, send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 12000);
      const close = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* closed */
        }
      };
      signal.addEventListener("abort", close);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

