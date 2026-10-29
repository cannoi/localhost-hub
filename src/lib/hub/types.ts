export type AppKind = "static" | "dynamic";
export type AppStatus = "running" | "stopped" | "crashed" | "starting" | "standby";
export type Supervisor = "child" | "inprocess" | "static" | "mirror";
export type Runtime = "static" | "node" | "python";

export type AppView = {
  id: string;
  name: string;
  slug: string;
  kind: AppKind;
  status: AppStatus;
  domain: string;
  /** Optional custom host/domain binding (metadata only until reverse proxy is configured). */
  customDomain?: string | null;
  internalPort: number | null;
  runtime: Runtime;
  template: string;
  restarts: number;
  lastError?: string;
  createdAt: string;
  /** ISO timestamp of last successful HTTP readiness (when known). */
  readyAt?: string;
  originHub: string;
  originName: string;
  supervisor: Supervisor;
};

export type BlockView = {
  index: number;
  timestamp: number;
  summary: string;
  hash: string;
  previousHash: string;
  signer: string;
  signerName: string;
  signature: string;
  validSig: boolean;
};

export type PeerView = {
  id: string;
  name: string;
  role: "local" | "peer";
  fingerprint: string;
  height: number;
  status: "synced" | "syncing" | "rejected";
  apps: number;
};

export type LogLine = {
  ts: number;
  stream: "stdout" | "stderr" | "sys";
  text: string;
};

export type Rejection = { ts: number; reason: string };

export type HubSnapshot = {
  hub: {
    id: string;
    name: string;
    fingerprint: string;
    isolated: true;
    dataDir: string;
    persistent: boolean;
    p2pMode: "simulated-mesh";
  };
  apps: AppView[];
  mirrors: AppView[];
  peers: PeerView[];
  chain: { height: number; valid: boolean; tip: string };
  blocks: BlockView[];
  rejections: Rejection[];
};

export type DeployInput = {
  name: string;
  kind: AppKind;
  template?: string;
  html?: string;
  zipBase64?: string;
  runtime?: "node" | "python";
  /** Optional custom domain label (stored as metadata; DNS/TLS not auto-provisioned). */
  customDomain?: string;
};


export type HubMetrics = {
  appsTotal: number;
  appsRunning: number;
  appsStopped: number;
  appsCrashed: number;
  chainHeight: number;
  chainValid: boolean;
  persistent: boolean;
  dataDir: string;
  processRssMb: number | null;
  processUptimeSec: number;
  portsInUse: number[];
  logLines: number;
  timestamp: string;
};

export type BackupBundle = {
  schema: number;
  exportedAt: string;
  hubId: string;
  hubName: string;
  fingerprint: string;
  /** SHA-256 over the canonical JSON of `state` (tamper/corruption check, not authentication). */
  integrity?: string;
  /** Full state without private keys in a separate sealed field note — keys stay in state for restore integrity. */
  state: {
    schema: number;
    keys: Array<{ id: string; name: string; role: string; pubPem: string; privPem: string }>;
    chain: unknown[];
    apps: unknown[];
    mirrors: unknown[];
  };
};
