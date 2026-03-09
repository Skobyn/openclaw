/**
 * SQLite storage layer for context archive.
 *
 * Uses node:sqlite DatabaseSync with FTS5 for keyword search
 * and sqlite-vec for vector similarity search.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

export type ArchiveChunkRecord = {
  id: string;
  sessionKey: string;
  text: string;
  embedding: number[];
  startTs: number;
  endTs: number;
  keywords: string[];
  turnStart: number;
  turnEnd: number;
  sourceFile?: string;
  model: string;
  createdAt: number;
  consolidated: number;
};

export function makeChunkId(
  sessionKey: string,
  turnStart: number,
  turnEnd: number,
  text: string,
  model: string,
): string {
  const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return createHash("sha256")
    .update(`${sessionKey}:${turnStart}:${turnEnd}:${textHash}:${model}`)
    .digest("hex");
}

export class ArchiveDB {
  private db: DatabaseSync;
  private vecAvailable = false;
  private vecDims: number | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema();
    this.tryLoadSqliteVec();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_chunks (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        keywords TEXT NOT NULL,
        turn_start INTEGER NOT NULL,
        turn_end INTEGER NOT NULL,
        source_file TEXT,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consolidated INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_archive_session_key ON archive_chunks(session_key);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_archive_timestamps ON archive_chunks(start_ts, end_ts);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_archive_consolidated ON archive_chunks(consolidated);`,
    );

    // FTS5 virtual table for keyword search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
          text,
          id UNINDEXED,
          session_key UNINDEXED,
          keywords UNINDEXED
        );
      `);
    } catch {
      // FTS5 not available — keyword search will be disabled
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private tryLoadSqliteVec(): void {
    try {
      const sqliteVec = require("sqlite-vec") as {
        getLoadablePath: () => string;
        load: (db: DatabaseSync) => void;
      };
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch {
      // sqlite-vec not available; vector search will be disabled
      this.vecAvailable = false;
    }
  }

  private ensureVecTable(dims: number): void {
    if (!this.vecAvailable) {
      return;
    }
    if (this.vecDims === dims) {
      return;
    }
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS archive_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dims}]);`,
      );
      this.vecDims = dims;
    } catch {
      this.vecAvailable = false;
    }
  }

  get isVecAvailable(): boolean {
    return this.vecAvailable;
  }

  insertChunk(record: ArchiveChunkRecord): void {
    const embeddingJson = JSON.stringify(record.embedding);
    const keywordsJson = JSON.stringify(record.keywords);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO archive_chunks
        (id, session_key, text, embedding, start_ts, end_ts, keywords, turn_start, turn_end, source_file, model, created_at, consolidated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionKey,
        record.text,
        embeddingJson,
        record.startTs,
        record.endTs,
        keywordsJson,
        record.turnStart,
        record.turnEnd,
        record.sourceFile ?? null,
        record.model,
        record.createdAt,
        record.consolidated,
      );

    // Insert into FTS
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO archive_fts (text, id, session_key, keywords)
          VALUES (?, ?, ?, ?)`,
        )
        .run(record.text, record.id, record.sessionKey, keywordsJson);
    } catch {
      // FTS not available
    }

    // Insert into vec table
    if (this.vecAvailable && record.embedding.length > 0) {
      this.ensureVecTable(record.embedding.length);
      if (this.vecDims !== null) {
        try {
          this.db
            .prepare(`INSERT OR IGNORE INTO archive_vec (id, embedding) VALUES (?, ?)`)
            .run(record.id, new Float32Array(record.embedding));
        } catch {
          // vec insert failed — non-fatal
        }
      }
    }
  }

  searchVector(
    queryVec: number[],
    limit: number,
    sessionKey?: string,
  ): Array<{ id: string; distance: number }> {
    if (!this.vecAvailable || !this.vecDims) {
      return [];
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT id, distance FROM archive_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(new Float32Array(queryVec), limit * 2) as Array<{
        id: string;
        distance: number;
      }>;

      if (!sessionKey) {
        return rows.slice(0, limit);
      }
      // Filter by session key post-query
      const filtered: Array<{ id: string; distance: number }> = [];
      for (const row of rows) {
        if (filtered.length >= limit) {
          break;
        }
        const chunk = this.db
          .prepare(`SELECT session_key FROM archive_chunks WHERE id = ?`)
          .get(row.id) as { session_key: string } | undefined;
        if (chunk && chunk.session_key === sessionKey) {
          filtered.push(row);
        }
      }
      return filtered;
    } catch {
      return [];
    }
  }

  searchFts(
    query: string,
    limit: number,
    sessionKey?: string,
  ): Array<{ id: string; rank: number }> {
    try {
      // Sanitize FTS query — escape double quotes
      const sanitized = query.replace(/"/g, '""');
      let sql: string;
      let params: unknown[];

      if (sessionKey) {
        sql = `SELECT id, rank FROM archive_fts WHERE archive_fts MATCH ? AND session_key = ? ORDER BY rank LIMIT ?`;
        params = [sanitized, sessionKey, limit];
      } else {
        sql = `SELECT id, rank FROM archive_fts WHERE archive_fts MATCH ? ORDER BY rank LIMIT ?`;
        params = [sanitized, limit];
      }

      return this.db.prepare(sql).all(...params) as Array<{ id: string; rank: number }>;
    } catch {
      return [];
    }
  }

  getChunkById(id: string): ArchiveChunkRecord | null {
    const row = this.db.prepare(`SELECT * FROM archive_chunks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    return this.rowToRecord(row);
  }

  getChunksByIds(ids: string[]): ArchiveChunkRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM archive_chunks WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRecord(row));
  }

  getLastArchivedOffset(sessionKey: string): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(`offset:${sessionKey}`) as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : -1;
  }

  setLastArchivedOffset(sessionKey: string, offset: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(`offset:${sessionKey}`, String(offset));
  }

  getUnconsolidatedChunks(limit: number): ArchiveChunkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM archive_chunks WHERE consolidated = 0 ORDER BY created_at LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRecord(row));
  }

  getUnconsolidatedCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM archive_chunks WHERE consolidated = 0`)
      .get() as { count: number };
    return row.count;
  }

  markConsolidated(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE archive_chunks SET consolidated = 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  getStats(): { totalChunks: number; sessions: number; dbSizeBytes: number } {
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM archive_chunks`)
      .get() as { count: number };
    const sessions = this.db
      .prepare(`SELECT COUNT(DISTINCT session_key) as count FROM archive_chunks`)
      .get() as { count: number };
    // page_count * page_size gives approximate DB size
    const pageCount = (
      this.db.prepare(`PRAGMA page_count`).get() as { page_count: number }
    ).page_count;
    const pageSize = (
      this.db.prepare(`PRAGMA page_size`).get() as { page_size: number }
    ).page_size;
    return {
      totalChunks: total.count,
      sessions: sessions.count,
      dbSizeBytes: pageCount * pageSize,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private rowToRecord(row: Record<string, unknown>): ArchiveChunkRecord {
    return {
      id: row.id as string,
      sessionKey: row.session_key as string,
      text: row.text as string,
      embedding: JSON.parse(row.embedding as string) as number[],
      startTs: row.start_ts as number,
      endTs: row.end_ts as number,
      keywords: JSON.parse(row.keywords as string) as string[],
      turnStart: row.turn_start as number,
      turnEnd: row.turn_end as number,
      sourceFile: (row.source_file as string) ?? undefined,
      model: row.model as string,
      createdAt: row.created_at as number,
      consolidated: row.consolidated as number,
    };
  }
}
