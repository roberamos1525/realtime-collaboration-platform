#!/usr/bin/env node
// Two WebSocket clients edit the same document concurrently and converge.
//
// Usage (server running, shared package built with `npm run build`):
//   node examples/two-clients.mjs
// Environment: BASE_URL (default http://127.0.0.1:4000)
import { RgaDocument } from "@rcp/shared";
import WebSocket from "ws";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4000";
const WS_URL = BASE_URL.replace(/^http/, "ws") + "/ws";
const stamp = Date.now().toString(36);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(payload)}`);
  return payload?.data;
}

async function register(name) {
  return api("POST", "/api/auth/register", {
    body: { email: `${name}-${stamp}@example.test`, username: `${name}_${stamp}`, displayName: name, password: "example-password-1" },
  });
}

/** Minimal client: authenticates, joins a document, applies remote ops to a local replica. */
function connect(name, token, docId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { name, ws, replica: null, acked: 0, sent: 0 };
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ready") ws.send(JSON.stringify({ type: "doc.join", docId }));
      if (msg.type === "doc.joined") {
        client.replica = RgaDocument.fromSnapshot(msg.snapshot, msg.site);
        resolve(client);
      }
      if (msg.type === "doc.op") client.replica.apply(msg.op);
      if (msg.type === "doc.ack") client.acked++;
      if (msg.type === "error") console.error(`[${name}] server error:`, msg);
    });
  });
}

function edit(client, fn) {
  const op = fn(client.replica);
  client.sent++;
  client.ws.send(JSON.stringify({ type: "doc.op", docId: client.docId, op }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alice = await register("alice");
const bob = await register("bob");
const ws = await api("POST", "/api/workspaces", { token: alice.accessToken, body: { name: `Example ${stamp}` } });
await api("POST", `/api/workspaces/${ws.id}/members`, { token: alice.accessToken, body: { identifier: bob.user.username, role: "editor" } });
const doc = await api("POST", `/api/workspaces/${ws.id}/documents`, {
  token: alice.accessToken,
  body: { title: "Convergence demo", content: "Hello world" },
});
console.log(`document ${doc.id} created with text: ${JSON.stringify(doc.text)}`);

const a = await connect("alice", alice.accessToken, doc.id);
const b = await connect("bob", bob.accessToken, doc.id);
a.docId = doc.id;
b.docId = doc.id;

// Concurrent edits: neither client has seen the other's changes yet.
edit(a, (r) => r.insert(5, ", brave new"));
edit(b, (r) => r.insert(r.length, "!"));
edit(b, (r) => r.delete(0, 1));
edit(b, (r) => r.insert(0, "J"));
edit(a, (r) => r.insert(0, ">> "));

for (let i = 0; i < 50 && (a.acked < a.sent || b.acked < b.sent); i++) await sleep(20);
await sleep(100);

const server = await api("GET", `/api/documents/${doc.id}`, { token: alice.accessToken });
console.log(`alice sees : ${JSON.stringify(a.replica.toString())}`);
console.log(`bob sees   : ${JSON.stringify(b.replica.toString())}`);
console.log(`server has : ${JSON.stringify(server.text)} (head seq ${server.headSeq})`);
const converged = a.replica.toString() === b.replica.toString() && b.replica.toString() === server.text;
console.log(converged ? "CONVERGED ✔" : "DIVERGED ✘");
a.ws.close();
b.ws.close();
process.exit(converged ? 0 : 1);
