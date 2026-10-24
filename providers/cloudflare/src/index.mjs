import { createSyncWorker } from "./worker.mjs";

class D1Repository {
  constructor(database) {
    this.database = database;
  }

  async getConfig() {
    const row = await this.database.prepare(`
      SELECT generation, kdf_salt, kdf_iterations, authentication_verifier, wrapped_data_key
      FROM sync_config WHERE id = 1
    `).first();
    if (!row) return null;
    return {
      generation: row.generation,
      kdfSalt: row.kdf_salt,
      kdfIterations: row.kdf_iterations,
      authenticationVerifier: row.authentication_verifier,
      wrappedDataKey: row.wrapped_data_key,
    };
  }

  async setup(credentials) {
    const result = await this.database.prepare(`
      INSERT OR IGNORE INTO sync_config (
        id, generation, kdf_salt, kdf_iterations, authentication_verifier, wrapped_data_key
      ) VALUES (1, 1, ?, ?, ?, ?)
    `).bind(
      credentials.kdfSalt,
      credentials.kdfIterations,
      credentials.authenticationVerifier,
      credentials.wrappedDataKey,
    ).run();
    return result.meta.changes === 1;
  }

  async updateCredentials(credentials) {
    await this.database.prepare(`
      UPDATE sync_config
      SET kdf_salt = ?, kdf_iterations = ?, authentication_verifier = ?,
          wrapped_data_key = ?, updated_at = unixepoch()
      WHERE id = 1
    `).bind(
      credentials.kdfSalt,
      credentials.kdfIterations,
      credentials.authenticationVerifier,
      credentials.wrappedDataKey,
    ).run();
  }

  async applyMutation(mutation) {
    const existing = await this.#processedMutation(mutation.mutationID);
    if (existing) return existing;

    const revision = crypto.randomUUID();
    try {
      await this.database.batch([
        this.database.prepare(`
          INSERT INTO changes (
            revision, entity_type, entity_id, deleted, payload, asset_key
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          revision,
          mutation.entityType,
          mutation.entityID,
          mutation.deleted ? 1 : 0,
          mutation.payload,
          mutation.assetKey,
        ),
        this.database.prepare(`
          INSERT INTO entities (
            entity_type, entity_id, revision, deleted, payload, asset_key
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            revision = excluded.revision,
            deleted = excluded.deleted,
            payload = excluded.payload,
            asset_key = excluded.asset_key,
            updated_at = unixepoch()
        `).bind(
          mutation.entityType,
          mutation.entityID,
          revision,
          mutation.deleted ? 1 : 0,
          mutation.payload,
          mutation.assetKey,
        ),
        this.database.prepare(`
          INSERT INTO processed_mutations (mutation_id, revision) VALUES (?, ?)
        `).bind(mutation.mutationID, revision),
      ]);
    } catch (error) {
      const raced = await this.#processedMutation(mutation.mutationID);
      if (raced) return raced;
      throw error;
    }
    return await this.#processedMutation(mutation.mutationID);
  }

  async #processedMutation(mutationID) {
    const row = await this.database.prepare(`
      SELECT p.mutation_id, p.revision, c.sequence
      FROM processed_mutations p
      JOIN changes c ON c.revision = p.revision
      WHERE p.mutation_id = ?
    `).bind(mutationID).first();
    return row ? {
      mutationID: row.mutation_id,
      sequence: row.sequence,
      revision: row.revision,
    } : null;
  }

  async pull(cursor, limit) {
    const result = await this.database.prepare(`
      SELECT sequence, revision, entity_type, entity_id, deleted, payload, asset_key
      FROM changes WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).bind(cursor, limit).all();
    return result.results.map(row => ({
      sequence: row.sequence,
      revision: row.revision,
      entityType: row.entity_type,
      entityID: row.entity_id,
      deleted: row.deleted === 1,
      payload: row.payload,
      assetKey: row.asset_key,
    }));
  }

  async reset(credentials, generation) {
    await this.database.batch([
      this.database.prepare("DELETE FROM processed_mutations"),
      this.database.prepare("DELETE FROM changes"),
      this.database.prepare("DELETE FROM entities"),
      this.database.prepare(`
        UPDATE sync_config
        SET generation = ?, kdf_salt = ?, kdf_iterations = ?,
            authentication_verifier = ?, wrapped_data_key = ?, updated_at = unixepoch()
        WHERE id = 1
      `).bind(
        generation,
        credentials.kdfSalt,
        credentials.kdfIterations,
        credentials.authenticationVerifier,
        credentials.wrappedDataKey,
      ),
    ]);
    return generation;
  }
}

class R2AssetStore {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async put(key, value) { await this.bucket.put(key, value); }

  async get(key) {
    const object = await this.bucket.get(key);
    return object?.body ?? null;
  }

  async delete(key) { await this.bucket.delete(key); }

  async clear() {
    while (true) {
      const page = await this.bucket.list({ limit: 1000 });
      if (page.objects.length === 0) return;
      await this.bucket.delete(page.objects.map(object => object.key));
    }
  }
}

export default {
  async fetch(request, env) {
    const worker = createSyncWorker({
      repository: new D1Repository(env.DB),
      assets: new R2AssetStore(env.ASSETS),
      setupToken: env.SETUP_TOKEN,
    });
    return worker.fetch(request);
  },
};
