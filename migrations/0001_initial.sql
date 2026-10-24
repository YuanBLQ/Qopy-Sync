CREATE TABLE sync_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL,
    kdf_salt TEXT NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    authentication_verifier TEXT NOT NULL,
    wrapped_data_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE entities (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    payload TEXT,
    asset_key TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    revision TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    payload TEXT,
    asset_key TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX changes_entity ON changes (entity_type, entity_id, sequence);

CREATE TABLE processed_mutations (
    mutation_id TEXT PRIMARY KEY,
    revision TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (revision) REFERENCES changes(revision) ON DELETE CASCADE
);
