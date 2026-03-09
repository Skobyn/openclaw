/**
 * Hybrid search and retrieval.
 *
 * Combines vector similarity (sqlite-vec) with FTS5 keyword search,
 * merged using reciprocal rank fusion (RRF). Falls back to FTS-only
 * when sqlite-vec is unavailable.
 */

import type { ArchiveDB, ArchiveChunkRecord } from "./db.js";
import type { ArchiveEmbeddings } from "./embeddings.js";
import type { PluginLogger } from "./types.js";

export type ArchiveSearchResult = {
  text: string;
  score: number;
  sessionKey: string;
  keywords: string[];
  startTs: number;
  endTs: number;
  chunkId: string;
};

/** RRF constant — controls rank blending. Commonly 60 in IR literature. */
const RRF_K = 60;

export class ContextRetriever {
  constructor(
    private db: ArchiveDB,
    private embeddings: ArchiveEmbeddings,
    private logger: PluginLogger,
  ) {}

  async search(params: {
    query: string;
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
  }): Promise<ArchiveSearchResult[]> {
    const { query, sessionKey, maxResults = 5, minScore = 0.05 } = params;

    if (!query.trim()) {
      return [];
    }

    const fetchLimit = maxResults * 3;

    // Run vector and FTS searches in parallel
    const [vecResults, ftsResults] = await Promise.all([
      this.vectorSearch(query, fetchLimit, sessionKey),
      this.ftsSearch(query, fetchLimit, sessionKey),
    ]);

    // Merge with RRF
    const merged = this.reciprocalRankFusion(vecResults, ftsResults);

    // Fetch full chunk data and filter
    const topIds = merged.slice(0, maxResults).filter((r) => r.score >= minScore);
    if (topIds.length === 0) {
      return [];
    }

    const chunks = this.db.getChunksByIds(topIds.map((r) => r.id));
    const chunkMap = new Map(chunks.map((c) => [c.id, c]));

    const results: ArchiveSearchResult[] = [];
    for (const scored of topIds) {
      const chunk = chunkMap.get(scored.id);
      if (!chunk) {
        continue;
      }
      // Apply consolidated penalty — deprioritize already-consolidated source chunks
      const consolidatedPenalty = chunk.consolidated ? 0.8 : 1.0;
      results.push({
        text: chunk.text,
        score: scored.score * consolidatedPenalty,
        sessionKey: chunk.sessionKey,
        keywords: chunk.keywords,
        startTs: chunk.startTs,
        endTs: chunk.endTs,
        chunkId: chunk.id,
      });
    }

    // Re-sort after penalty
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private async vectorSearch(
    query: string,
    limit: number,
    sessionKey?: string,
  ): Promise<Array<{ id: string; rank: number }>> {
    if (!this.db.isVecAvailable) {
      return [];
    }
    try {
      const queryVec = await this.embeddings.embedQuery(query);
      if (queryVec.length === 0) {
        return [];
      }
      const raw = this.db.searchVector(queryVec, limit, sessionKey);
      return raw.map((r, i) => ({ id: r.id, rank: i + 1 }));
    } catch (err) {
      this.logger.warn(`context-archive: vector search failed: ${String(err)}`);
      return [];
    }
  }

  private ftsSearch(
    query: string,
    limit: number,
    sessionKey?: string,
  ): Array<{ id: string; rank: number }> {
    try {
      // Build FTS query: split words joined with OR for broad matching
      const words = query
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => w.replace(/[^\w]/g, ""))
        .filter(Boolean);
      const ftsQuery = words.length > 0 ? words.join(" OR ") : query;

      const raw = this.db.searchFts(ftsQuery, limit, sessionKey);
      return raw.map((r, i) => ({ id: r.id, rank: i + 1 }));
    } catch (err) {
      this.logger.warn(`context-archive: FTS search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) — merges ranked lists from different retrieval methods.
   *
   * score(doc) = sum over lists: 1 / (K + rank_in_list)
   */
  private reciprocalRankFusion(
    ...lists: Array<Array<{ id: string; rank: number }>>
  ): Array<{ id: string; score: number }> {
    const scores = new Map<string, number>();

    for (const list of lists) {
      for (const item of list) {
        const rrfScore = 1 / (RRF_K + item.rank);
        scores.set(item.id, (scores.get(item.id) ?? 0) + rrfScore);
      }
    }

    const merged = [...scores.entries()].map(([id, score]) => ({ id, score }));
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }
}
