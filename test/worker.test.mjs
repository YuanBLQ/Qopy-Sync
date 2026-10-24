import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAssetStore, MemoryRepository, createSyncWorker } from "../src/worker.mjs";

const encoder = new TextEncoder();

async function verifierFor(key) {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(key, "base64"));
  return Buffer.from(digest).toString("base64");
}

function jsonRequest(path, { method = "GET", token, setupToken, body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (setupToken) headers.set("X-Qopy-Setup-Token", setupToken);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://sync.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeInitializedWorker() {
  const repository = new MemoryRepository();
  const assets = new MemoryAssetStore();
  const worker = createSyncWorker({ repository, assets, setupToken: "initial-token" });
  const authKey = Buffer.from(encoder.encode("32-byte-authentication-key-value!"))
    .subarray(0, 32)
    .toString("base64");
  const response = await worker.fetch(jsonRequest("/v1/setup", {
    method: "POST",
    setupToken: "initial-token",
    body: {
      kdfSalt: Buffer.alloc(16, 3).toString("base64"),
      kdfIterations: 310000,
      authenticationVerifier: await verifierFor(authKey),
      wrappedDataKey: Buffer.alloc(60, 7).toString("base64"),
    },
  }));
  assert.equal(response.status, 201);
  return { worker, repository, assets, authKey };
}

test("setup is one-time and requires the deployment token", async () => {
  const repository = new MemoryRepository();
  const worker = createSyncWorker({
    repository,
    assets: new MemoryAssetStore(),
    setupToken: "correct-token",
  });
  const body = {
    kdfSalt: Buffer.alloc(16, 1).toString("base64"),
    kdfIterations: 310000,
    authenticationVerifier: Buffer.alloc(32, 2).toString("base64"),
    wrappedDataKey: Buffer.alloc(60, 3).toString("base64"),
  };

  assert.equal((await worker.fetch(jsonRequest("/v1/setup", {
    method: "POST", setupToken: "wrong", body,
  }))).status, 401);
  assert.equal((await worker.fetch(jsonRequest("/v1/setup", {
    method: "POST", setupToken: "correct-token", body,
  }))).status, 201);
  assert.equal((await worker.fetch(jsonRequest("/v1/setup", {
    method: "POST", setupToken: "correct-token", body,
  }))).status, 409);

  const config = await (await worker.fetch(jsonRequest("/v1/config"))).json();
  assert.deepEqual(config, {
    initialized: true,
    protocolVersion: 1,
    generation: 1,
    kdfSalt: body.kdfSalt,
    kdfIterations: body.kdfIterations,
    wrappedDataKey: body.wrappedDataKey,
  });
});

test("authenticated pushes are idempotent and can be pulled incrementally", async () => {
  const { worker, authKey } = await makeInitializedWorker();
  const mutation = {
    mutationID: "mutation-1",
    entityType: "setting",
    entityID: "historyLimit",
    deleted: false,
    payload: Buffer.from("encrypted-setting").toString("base64"),
  };

  assert.equal((await worker.fetch(jsonRequest("/v1/push", {
    method: "POST", body: { mutations: [mutation] },
  }))).status, 401);

  const first = await (await worker.fetch(jsonRequest("/v1/push", {
    method: "POST", token: authKey, body: { mutations: [mutation] },
  }))).json();
  const repeated = await (await worker.fetch(jsonRequest("/v1/push", {
    method: "POST", token: authKey, body: { mutations: [mutation] },
  }))).json();
  assert.deepEqual(repeated, first);

  const pull = await (await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=1", {
    token: authKey,
  }))).json();
  assert.equal(pull.changes.length, 1);
  assert.equal(pull.changes[0].entityID, "historyLimit");
  assert.equal(pull.cursor, 1);

  const empty = await (await worker.fetch(jsonRequest("/v1/pull?cursor=1&generation=1", {
    token: authKey,
  }))).json();
  assert.deepEqual(empty.changes, []);
});

test("reset clears old cloud state and starts a new generation", async () => {
  const { worker, authKey } = await makeInitializedWorker();
  await worker.fetch(jsonRequest("/v1/push", {
    method: "POST",
    token: authKey,
    body: { mutations: [{
      mutationID: "mutation-before-reset",
      entityType: "folder",
      entityID: "folder-1",
      deleted: false,
      payload: Buffer.from("encrypted-folder").toString("base64"),
    }] },
  }));

  const newAuthKey = Buffer.alloc(32, 9).toString("base64");
  const reset = await worker.fetch(jsonRequest("/v1/reset", {
    method: "POST",
    token: authKey,
    body: {
      kdfSalt: Buffer.alloc(16, 8).toString("base64"),
      kdfIterations: 310000,
      authenticationVerifier: await verifierFor(newAuthKey),
      wrappedDataKey: Buffer.alloc(60, 4).toString("base64"),
    },
  }));
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).generation, 2);

  assert.equal((await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=2", {
    token: newAuthKey,
  }))).status, 200);
  assert.equal((await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=1", {
    token: newAuthKey,
  }))).status, 409);
  assert.equal((await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=2", {
    token: authKey,
  }))).status, 401);
});

test("changing credentials keeps cloud data and invalidates the old key", async () => {
  const { worker, authKey } = await makeInitializedWorker();
  await worker.fetch(jsonRequest("/v1/push", {
    method: "POST",
    token: authKey,
    body: { mutations: [{
      mutationID: "mutation-before-password-change",
      entityType: "setting",
      entityID: "historyLimit",
      deleted: false,
      payload: Buffer.from("encrypted-setting").toString("base64"),
    }] },
  }));

  const newAuthKey = Buffer.alloc(32, 6).toString("base64");
  const response = await worker.fetch(jsonRequest("/v1/credentials", {
    method: "PUT",
    token: authKey,
    body: {
      kdfSalt: Buffer.alloc(16, 5).toString("base64"),
      kdfIterations: 310000,
      authenticationVerifier: await verifierFor(newAuthKey),
      wrappedDataKey: Buffer.alloc(60, 4).toString("base64"),
    },
  }));
  assert.equal(response.status, 200);
  assert.equal((await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=1", {
    token: authKey,
  }))).status, 401);

  const pull = await (await worker.fetch(jsonRequest("/v1/pull?cursor=0&generation=1", {
    token: newAuthKey,
  }))).json();
  assert.equal(pull.changes.length, 1);
});

test("assets require authentication and are removed by reset", async () => {
  const { worker, authKey } = await makeInitializedWorker();
  const bytes = encoder.encode("encrypted-image");
  const put = new Request("https://sync.example/v1/assets/clip-1", {
    method: "PUT",
    headers: { Authorization: `Bearer ${authKey}` },
    body: bytes,
  });
  assert.equal((await worker.fetch(put)).status, 204);
  assert.equal((await worker.fetch(new Request(
    "https://sync.example/v1/assets/clip-1",
  ))).status, 401);

  const get = await worker.fetch(new Request("https://sync.example/v1/assets/clip-1", {
    headers: { Authorization: `Bearer ${authKey}` },
  }));
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), bytes);

  const newAuthKey = Buffer.alloc(32, 9).toString("base64");
  await worker.fetch(jsonRequest("/v1/reset", {
    method: "POST",
    token: authKey,
    body: {
      kdfSalt: Buffer.alloc(16, 8).toString("base64"),
      kdfIterations: 310000,
      authenticationVerifier: await verifierFor(newAuthKey),
      wrappedDataKey: Buffer.alloc(60, 4).toString("base64"),
    },
  }));
  assert.equal((await worker.fetch(new Request("https://sync.example/v1/assets/clip-1", {
    headers: { Authorization: `Bearer ${newAuthKey}` },
  }))).status, 404);
});
