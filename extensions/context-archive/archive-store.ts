/**
 * SQLite storage for context archive chunks with vector embeddings.
 *
 * Uses cosine similarity computed in JS (no sqlite-vec dependency required).
 * Vectors are stored as JSON arrays. FTS5 provides keyword fallback search.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ArchiveChunk = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  topics: string[];
  entities: string[];
  decisions: string[];
  embedding: number[] | null;
  createdAt: number;
};

export type ArchiveSearchResult = {
  chunk: ArchiveChunk;
  score: number;
};

type ChunkRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  topics: string;
  entities: string;
  decisions: string;
  embedding: string | null;
  created_at: number;
};

function rowToChunk(row: ChunkRow): ArchiveChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    topics: JSON.parse(row.topics) as string[],
    entities: JSON.parse(row.entities) as string[],
    decisions: JSON.parse(row.decisions) as string[],
    embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : null,
    createdAt: row.created_at,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-10 ? 0 : dot / denom;
}

export class ArchiveStore {
  private db: DatabaseSync;
  private ftsAvailable = false;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_chunks (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        entities   TEXT NOT NULL DEFAULT '[]',
        decisions  TEXT NOT NULL DEFAULT '[]',
        embedding  TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_archive_session ON archive_chunks(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_archive_created ON archive_chunks(created_at)");

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts
        USING fts5(id, content)
      `);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  store(chunk: Omit<ArchiveChunk, "id" | "createdAt">): ArchiveChunk {
    const full: ArchiveChunk = {
      ...chunk,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        "INSERT INTO archive_chunks (id, session_id, role, content, topics, entities, decisions, embedding, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        full.id,
        full.sessionId,
        full.role,
        full.content,
        JSON.stringify(full.topics),
        JSON.stringify(full.entities),
        JSON.stringify(full.decisions),
        full.embedding ? JSON.stringify(full.embedding) : null,
        full.createdAt,
      );

    if (this.ftsAvailable) {
      this.db
        .prepare("INSERT INTO archive_fts (id, content) VALUES (?, ?)")
        .run(full.id, full.content);
    }

    return full;
  }

  storeBatch(chunks: Array<Omit<ArchiveChunk, "id" | "createdAt">>): ArchiveChunk[] {
    const results: ArchiveChunk[] = [];
    const insertStmt = this.db.prepare(
      "INSERT INTO archive_chunks (id, session_id, role, content, topics, entities, decisions, embedding, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const ftsStmt = this.ftsAvailable
      ? this.db.prepare("INSERT INTO archive_fts (id, content) VALUES (?, ?)")
      : null;

    for (const chunk of chunks) {
      const full: ArchiveChunk = {
        ...chunk,
        id: randomUUID(),
        createdAt: Date.now(),
      };
      insertStmt.run(
        full.id,
        full.sessionId,
        full.role,
        full.content,
        JSON.stringify(full.topics),
        JSON.stringify(full.entities),
        JSON.stringify(full.decisions),
        full.embedding ? JSON.stringify(full.embedding) : null,
        full.createdAt,
      );
      ftsStmt?.run(full.id, full.content);
      results.push(full);
    }
    return results;
  }

  /**
   * Vector similarity search. Loads all embeddings and computes cosine similarity in JS.
   * For archive sizes under ~50k chunks this is fast enough.
   */
  vectorSearch(queryEmbedding: number[], topK: number, minScore: number): ArchiveSearchResult[] {
    const rows = this.db
      .prepare(
        "SELECT id, session_id, role, content, topics, entities, decisions, embedding, created_at " +
          "FROM archive_chunks WHERE embedding IS NOT NULL",
      )
      .all() as ChunkRow[];

    const scored: ArchiveSearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const stored = JSON.parse(row.embedding) as number[];
      const score = cosineSimilarity(queryEmbedding, stored);
      if (score >= minScore) {
        scored.push({ chunk: rowToChunk(row), score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** FTS5 keyword fallback search. */
  keywordSearch(query: string, topK: number): ArchiveSearchResult[] {
    if (!this.ftsAvailable) return [];
    const rows = this.db
      .prepare(
        "SELECT c.id, c.session_id, c.role, c.content, c.topics, c.entities, c.decisions, c.embedding, c.created_at, " +
          "rank " +
          "FROM archive_fts f " +
          "JOIN archive_chunks c ON c.id = f.id " +
          "WHERE archive_fts MATCH ? " +
          "ORDER BY rank LIMIT ?",
      )
      .all(query, topK) as Array<ChunkRow & { rank: number }>;

    return rows.map((row) => ({
      chunk: rowToChunk(row),
      score: 1 / (1 + Math.abs(row.rank)),
    }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM archive_chunks").get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
