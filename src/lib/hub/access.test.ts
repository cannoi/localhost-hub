import test from "node:test";
import assert from "node:assert/strict";
import { decideAccess, isPrivateIp, sameOriginOk, secretMatches } from "./access.ts";

const h = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const open = { secret: "", trustProxy: false };
const locked = { secret: "s3cret-value", trustProxy: false };

test("private ip classification", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:10.1.2.3", "192.168.1.5", "172.17.0.1", "172.31.255.1", "fd00::1"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "2001:db8::1", "", "192.169.0.1"]) assert.equal(isPrivateIp(ip), false, ip);
});

test("spoofed headers never grant access to a public peer", () => {
  const spoof = h({ "x-forwarded-for": "127.0.0.1", host: "localhost", origin: "http://localhost", referer: "http://localhost/" });
  assert.equal(decideAccess(spoof, "203.0.113.9", open).ok, false);
  assert.equal(decideAccess(h({ host: "localhost" }), "203.0.113.9", locked).ok, false);
});

test("unknown peer fails closed without secret", () => {
  const d = decideAccess(h(), null, open);
  assert.equal(d.ok, false);
});

test("private direct peer allowed without secret", () => {
  assert.equal(decideAccess(h(), "192.168.1.20", open).ok, true);
});

test("proxied request without secret denied unless proxy trusted and client private", () => {
  const via = h({ "x-forwarded-for": "198.51.100.7" });
  assert.equal(decideAccess(via, "172.18.0.1", open).ok, false);
  assert.equal(decideAccess(via, "172.18.0.1", { ...open, trustProxy: true }).ok, false);
  assert.equal(decideAccess(h({ "x-forwarded-for": "192.168.1.9" }), "172.18.0.1", { ...open, trustProxy: true }).ok, true);
  assert.equal(decideAccess(h({ "x-forwarded-for": "192.168.1.9, 8.8.8.8" }), "172.18.0.1", { ...open, trustProxy: true }).ok, false);
});

test("valid secret works from anywhere, wrong/empty secret does not", () => {
  assert.equal(decideAccess(h({ "x-hub-secret": "s3cret-value" }), "8.8.8.8", locked).ok, true);
  assert.equal(decideAccess(h({ authorization: "Bearer s3cret-value" }), null, locked).ok, true);
  assert.equal(decideAccess(h({ "x-hub-secret": "nope" }), "8.8.8.8", locked).ok, false);
  assert.equal(secretMatches("", ""), false);
  // secret configured => network position is irrelevant (Docker gateway looks private)
  assert.equal(decideAccess(h(), "172.18.0.1", locked).ok, false);
  assert.equal(decideAccess(h({ "x-forwarded-for": "192.168.1.9" }), "127.0.0.1", { ...locked, trustProxy: true }).ok, false);
});

test("same-origin guard", () => {
  assert.equal(sameOriginOk(h()), true);
  assert.equal(sameOriginOk(h({ origin: "http://hub.lan:48080", host: "hub.lan:48080" })), true);
  assert.equal(sameOriginOk(h({ origin: "http://evil.example", host: "hub.lan:48080" })), false);
  assert.equal(sameOriginOk(h({ origin: "null", host: "hub.lan" })), false);
});
