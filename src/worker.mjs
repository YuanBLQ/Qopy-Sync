const protocolVersion = 1;
const maxMutationsPerPush = 100;
const maxStringLength = 512;

class HTTPError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    throw new HTTPError(400, "invalid_json", "The request body must be valid JSON.");
  }
}

function decodeBase64(value, field, expectedLength) {
  if (typeof value !== "string") {
    throw new HTTPError(400, "invalid_request", `${field} must be base64 text.`);
  }
  let bytes;
  try {
    const binary = atob(value);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new HTTPError(400, "invalid_request", `${field} must be valid base64 text.`);
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new HTTPError(400, "invalid_request", `${field} has an invalid length.`);
  }
  return bytes;
}

function validateCredentialBody(body) {
  decodeBase64(body?.kdfSalt, "kdfSalt", 16);
  decodeBase64(body?.authenticationVerifier, "authenticationVerifier", 32);
  decodeBase64(body?.wrappedDataKey, "wrappedDataKey", 60);
  if (!Number.isSafeInteger(body?.kdfIterations) || body.kdfIterations < 100_000) {
    throw new HTTPError(400, "invalid_request", "kdfIterations is too small.");
  }
  return {
    kdfSalt: body.kdfSalt,
    kdfIterations: body.kdfIterations,
    authenticationVerifier: body.authenticationVerifier,
    wrappedDataKey: body.wrappedDataKey,
  };
}

function validateMutation(mutation) {
  for (const field of ["mutationID", "entityType", "entityID"]) {
    const value = mutation?.[field];
    if (typeof value !== "string" || value.length === 0 || value.length > maxStringLength) {
      throw new HTTPError(400, "invalid_mutation", `${field} is invalid.`);
    }
  }
  if (typeof mutation.deleted !== "boolean") {
    throw new HTTPError(400, "invalid_mutation", "deleted must be a boolean.");
  }
  if (!mutation.deleted) decodeBase64(mutation.payload, "payload");
  if (mutation.assetKey !== undefined && mutation.assetKey !== null) {
    if (typeof mutation.assetKey !== "string" || mutation.assetKey.length > maxStringLength) {
      throw new HTTPError(400, "invalid_mutation", "assetKey is invalid.");
    }
  }
  return {
    mutationID: mutation.mutationID,
    entityType: mutation.entityType,
    entityID: mutation.entityID,
    deleted: mutation.deleted,
    payload: mutation.deleted ? null : mutation.payload,
    assetKey: mutation.assetKey ?? null,
  };
}

async function sha256Base64(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function requireAuthentication(request, repository) {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    throw new HTTPError(401, "authentication_required", "Authentication is required.");
  }
  const authenticationKey = decodeBase64(header.slice(7), "authentication key", 32);
  const config = await repository.getConfig();
  if (!config) throw new HTTPError(409, "not_initialized", "Sync has not been initialized.");
  const verifier = await sha256Base64(authenticationKey);
  if (!timingSafeEqual(verifier, config.authenticationVerifier)) {
    throw new HTTPError(401, "invalid_credentials", "The synchronization password is incorrect.");
  }
  return config;
}

export function createSyncWorker({ repository, assets, setupToken }) {
  return {
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/health") {
          return json({ ok: true, protocolVersion });
        }
        if (request.method === "GET" && url.pathname === "/v1/config") {
          const config = await repository.getConfig();
          if (!config) return json({ initialized: false, protocolVersion });
          return json({
            initialized: true,
            protocolVersion,
            generation: config.generation,
            kdfSalt: config.kdfSalt,
            kdfIterations: config.kdfIterations,
            wrappedDataKey: config.wrappedDataKey,
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/setup") {
          if (!setupToken || !timingSafeEqual(
            request.headers.get("X-Qopy-Setup-Token") ?? "",
            setupToken,
          )) {
            throw new HTTPError(401, "invalid_setup_token", "The setup token is incorrect.");
          }
          if (await repository.getConfig()) {
            throw new HTTPError(409, "already_initialized", "Sync has already been initialized.");
          }
          const credentials = validateCredentialBody(await readJSON(request));
          if (await repository.setup(credentials) === false) {
            throw new HTTPError(409, "already_initialized", "Sync has already been initialized.");
          }
          return json({ generation: 1 }, 201);
        }
        if (request.method === "POST" && url.pathname === "/v1/push") {
          const config = await requireAuthentication(request, repository);
          const body = await readJSON(request);
          if (!Array.isArray(body?.mutations) || body.mutations.length > maxMutationsPerPush) {
            throw new HTTPError(400, "invalid_request", "mutations must contain at most 100 items.");
          }
          const results = [];
          for (const item of body.mutations.map(validateMutation)) {
            results.push(await repository.applyMutation(item));
          }
          return json({ generation: config.generation, results });
        }
        if (request.method === "GET" && url.pathname === "/v1/pull") {
          const config = await requireAuthentication(request, repository);
          const cursor = Number(url.searchParams.get("cursor") ?? "0");
          const generation = Number(url.searchParams.get("generation") ?? "0");
          if (!Number.isSafeInteger(cursor) || cursor < 0) {
            throw new HTTPError(400, "invalid_cursor", "The cursor is invalid.");
          }
          if (generation !== config.generation) {
            throw new HTTPError(409, "generation_mismatch", "The cloud data was rebuilt.");
          }
          const changes = await repository.pull(cursor, 200);
          return json({
            generation,
            cursor: changes.length === 0 ? cursor : changes.at(-1).sequence,
            changes,
          });
        }
        if (request.method === "PUT" && url.pathname === "/v1/credentials") {
          const config = await requireAuthentication(request, repository);
          const credentials = validateCredentialBody(await readJSON(request));
          await repository.updateCredentials(credentials);
          return json({ generation: config.generation });
        }
        if (request.method === "POST" && url.pathname === "/v1/reset") {
          const config = await requireAuthentication(request, repository);
          const credentials = validateCredentialBody(await readJSON(request));
          await assets.clear();
          const generation = await repository.reset(credentials, config.generation + 1);
          return json({ generation });
        }
        if (url.pathname.startsWith("/v1/assets/")) {
          await requireAuthentication(request, repository);
          const key = decodeURIComponent(url.pathname.slice("/v1/assets/".length));
          if (!key || key.length > maxStringLength || key.includes("/")) {
            throw new HTTPError(400, "invalid_asset_key", "The asset key is invalid.");
          }
          if (request.method === "PUT") {
            await assets.put(key, new Uint8Array(await request.arrayBuffer()));
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            const value = await assets.get(key);
            if (!value) throw new HTTPError(404, "asset_not_found", "The asset was not found.");
            return new Response(value, {
              headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
            });
          }
          if (request.method === "DELETE") {
            await assets.delete(key);
            return new Response(null, { status: 204 });
          }
        }
        throw new HTTPError(404, "not_found", "The endpoint does not exist.");
      } catch (error) {
        if (error instanceof HTTPError) {
          return json({ error: error.code, message: error.message }, error.status);
        }
        console.error(error);
        return json({ error: "internal_error", message: "The sync service failed." }, 500);
      }
    },
  };
}

export class MemoryRepository {
  #config = null;
  #changes = [];
  #entities = new Map();
  #processed = new Map();

  async getConfig() {
    return this.#config && { ...this.#config };
  }

  async setup(credentials) {
    if (this.#config) return false;
    this.#config = { ...credentials, generation: 1 };
    return true;
  }

  async updateCredentials(credentials) {
    this.#config = { ...this.#config, ...credentials };
  }

  async applyMutation(mutation) {
    const processed = this.#processed.get(mutation.mutationID);
    if (processed) return { ...processed };
    const sequence = this.#changes.length + 1;
    const revision = crypto.randomUUID();
    const change = { ...mutation, sequence, revision };
    delete change.mutationID;
    this.#changes.push(change);
    this.#entities.set(`${mutation.entityType}:${mutation.entityID}`, change);
    const result = { mutationID: mutation.mutationID, sequence, revision };
    this.#processed.set(mutation.mutationID, result);
    return { ...result };
  }

  async pull(cursor, limit) {
    return this.#changes.filter(change => change.sequence > cursor).slice(0, limit);
  }

  async reset(credentials, generation) {
    this.#changes = [];
    this.#entities.clear();
    this.#processed.clear();
    this.#config = { ...credentials, generation };
    return generation;
  }
}

export class MemoryAssetStore {
  #values = new Map();

  async put(key, value) { this.#values.set(key, value); }
  async get(key) { return this.#values.get(key) ?? null; }
  async delete(key) { this.#values.delete(key); }
  async clear() { this.#values.clear(); }
}
