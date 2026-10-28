"use strict";

const crypto = require("crypto");

const ZERO = "0".repeat(64);

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hashBlock(block) {
  const payload = `${block.index}|${block.timestamp}|${stable(block.data)}|${block.previousHash}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function fingerprint(pem) {
  return crypto.createHash("sha256").update(pem).digest("hex").slice(0, 12);
}

function createKeyPair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    pubPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function loadKeyPair(pubPem, privPem) {
  return {
    publicKey: crypto.createPublicKey(pubPem),
    privateKey: crypto.createPrivateKey(privPem),
    pubPem,
    privPem,
  };
}

function signHash(hash, privateKey) {
  return crypto.sign(null, Buffer.from(hash), privateKey).toString("base64");
}

function verifyHash(hash, signature, publicKey) {
  try {
    return crypto.verify(null, Buffer.from(hash), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function verifyBlock(block, publicKey, previousHash) {
  if (!block || typeof block.index !== "number") return "block không hợp lệ";
  if (block.previousHash !== previousHash) return "previousHash không khớp";
  if (hashBlock(block) !== block.hash) return "SHA-256 không khớp nội dung khối";
  if (!publicKey || !verifyHash(block.hash, block.signature, publicKey)) return "chữ ký Ed25519 không hợp lệ";
  return null;
}

function createLedger(keys) {
  const genesisPartial = {
    index: 0,
    timestamp: Date.now(),
    data: { type: "genesis", hubId: keys.hubId, note: "Ofie consortium ledger" },
    previousHash: ZERO,
  };
  const hash = hashBlock(genesisPartial);
  const chain = [
    {
      ...genesisPartial,
      hash,
      signature: signHash(hash, keys.privateKey),
      signer: keys.hubId,
    },
  ];
  const trusted = new Map([[keys.hubId, keys.publicKey]]);

  function tip() {
    return chain[chain.length - 1];
  }

  function commit(data, signer) {
    const previous = tip();
    const partial = {
      index: previous.index + 1,
      timestamp: Date.now(),
      data,
      previousHash: previous.hash,
    };
    const blockHash = hashBlock(partial);
    const block = {
      ...partial,
      hash: blockHash,
      signature: signHash(blockHash, signer.privateKey),
      signer: signer.hubId,
    };
    const reason = accept(block, false);
    if (reason) throw new Error(reason);
    return block;
  }

  function accept(block, relayOk) {
    const previous = tip();
    const key = trusted.get(block.signer) || (block.signer === keys.hubId ? keys.publicKey : null);
    const reason = verifyBlock(block, key, previous.hash);
    if (reason) return reason;
    if (block.index !== previous.index + 1) return "index không nối tiếp";
    if (chain.some((item) => item.hash === block.hash)) return null;
    chain.push(block);
    return null;
  }

  function trust(hubId, publicKey) {
    trusted.set(hubId, publicKey);
  }

  function exportChain() {
    return chain.map((block) => ({ ...block }));
  }

  function replaceIfValid(blocks, resolveKey) {
    if (!Array.isArray(blocks) || blocks.length === 0) return "chuỗi rỗng";
    if (blocks.length <= chain.length && blocks[blocks.length - 1].hash === tip().hash) return null;
    let prev = ZERO;
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.index !== i) return `index lệch tại ${i}`;
      const key = resolveKey(block.signer);
      const reason = verifyBlock(block, key, prev);
      if (reason) return reason;
      prev = block.hash;
    }
    if (blocks.length < chain.length) return "chuỗi ngắn hơn bản cục bộ";
    chain.splice(0, chain.length, ...blocks.map((block) => ({ ...block })));
    return null;
  }

  return { commit, accept, trust, tip, exportChain, replaceIfValid, ZERO };
}

module.exports = {
  ZERO,
  stable,
  hashBlock,
  fingerprint,
  createKeyPair,
  loadKeyPair,
  signHash,
  verifyHash,
  verifyBlock,
  createLedger,
};
