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
  internalPort: number | null;
  runtime: Runtime;
  template: string;
  restarts: number;
  lastError?: string;
  createdAt: string;
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
};
