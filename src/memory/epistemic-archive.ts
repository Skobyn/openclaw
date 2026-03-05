/**
 * SQLite storage for epistemic decision chunks.
 *
 * Separate from the main memory index (which indexes files/sessions as
 * document chunks). This stores per-turn conversation data with extracted
 * decisions, entities, and topics for contradiction detection.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DecisionChunk, EpistemicSearchResult } from "./epistemic-types.js";

export class EpistemicArchive {
  private db: DatabaseSync;
  private ftsAvailable = false;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.createTables();
  }

  // -------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------

  storeChunk(chunk: DecisionChunk): void {
    this.insertChunk(chunk);
  }

  storeChunks(chunks: DecisionChunk[]): void {
    for (const chunk of chunks) {
      this.insertChunk(chunk);
    }
  }

  // -------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------

  getChunk(chunkId: string): DecisionChunk | undefined {
    const row = this.db
      .prepare(
        "SELECT chunk_id, session_id, turn_id, role, content, " +
          "timestamp, topics, entities, decisions " +
          "FROM decision_chunks WHERE chunk_id = ?",
      )
      .get(chunkId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  getAllChunks(): DecisionChunk[] {
    const rows = this.db
      .prepare(
        "SELECT chunk_id, session_id, turn_id, role, content, " +
          "timestamp, topics, entities, decisions " +
          "FROM decision_chunks ORDER BY timestamp, turn_id",
      )
      .all() as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getAllDecisions(): DecisionChunk[] {
    const rows = this.db
      .prepare(
        "SELECT chunk_id, session_id, turn_id, role, content, " +
          "timestamp, topics, entities, decisions " +
          "FROM decision_chunks WHERE decisions != '[]' ORDER BY timestamp",
      )
      .all() as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getSessionChunks(sessionId: string): DecisionChunk[] {
    const rows = this.db
      .prepare(
        "SELECT chunk_id, session_id, turn_id, role, content, " +
          "timestamp, topics, entities, decisions " +
          "FROM decision_chunks WHERE session_id = ? ORDER BY turn_id",
      )
      .all(sessionId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  keywordSearch(query: string, topK = 5): EpistemicSearchResult[] {
    if (!this.ftsAvailable) {
      return [];
    }

    const rows = this.db
      .prepare(
        "SELECT c.chunk_id, c.session_id, c.turn_id, c.role, c.content, " +
          "c.timestamp, c.topics, c.entities, c.decisions, " +
          "rank " +
          "FROM decision_fts f " +
          "JOIN decision_chunks c ON c.chunk_id = f.chunk_id " +
          "WHERE decision_fts MATCH ? " +
          "ORDER BY rank " +
          "LIMIT ?",
      )
      .all(query, topK) as Array<ChunkRow & { rank: number }>;

    return rows.map((row) => ({
      chunk: rowToChunk(row),
      score: 1 / (1 + Math.abs(row.rank)),
      matchType: "keyword" as const,
    }));
  }

  countChunks(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM decision_chunks").get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_chunks (
        chunk_id   TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id    INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        entities   TEXT NOT NULL DEFAULT '[]',
        decisions  TEXT NOT NULL DEFAULT '[]'
      )
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_decision_chunks_session ON decision_chunks(session_id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_decision_chunks_timestamp ON decision_chunks(timestamp)",
    );

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS decision_fts
        USING fts5(chunk_id, content)
      `);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private insertChunk(chunk: DecisionChunk): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO decision_chunks " +
          "(chunk_id, session_id, turn_id, role, content, " +
          "timestamp, topics, entities, decisions) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        chunk.chunkId,
        chunk.sessionId,
        chunk.turnId,
        chunk.role,
        chunk.content,
        chunk.timestamp,
        JSON.stringify(chunk.topics),
        JSON.stringify(chunk.entities),
        JSON.stringify(chunk.decisions),
      );

    if (this.ftsAvailable) {
      this.db.prepare("DELETE FROM decision_fts WHERE chunk_id = ?").run(chunk.chunkId);
      this.db
        .prepare("INSERT INTO decision_fts (chunk_id, content) VALUES (?, ?)")
        .run(chunk.chunkId, chunk.content);
    }
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

type ChunkRow = {
  chunk_id: string;
  session_id: string;
  turn_id: number;
  role: string;
  content: string;
  timestamp: string;
  topics: string;
  entities: string;
  decisions: string;
};

function rowToChunk(row: ChunkRow): DecisionChunk {
  return {
    chunkId: row.chunk_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role as DecisionChunk["role"],
    content: row.content,
    timestamp: row.timestamp,
    topics: JSON.parse(row.topics) as string[],
    entities: JSON.parse(row.entities) as string[],
    decisions: JSON.parse(row.decisions) as string[],
  };
}
