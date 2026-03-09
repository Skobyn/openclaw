/**
 * Simple chunk consolidation (v1 — no LLM required).
 *
 * When unconsolidated chunk count exceeds a threshold, groups chunks by
 * session, merges those with overlapping keywords (Jaccard > 0.3), re-embeds
 * the merged text, and stores as a new consolidated chunk.
 */

import type { ContextArchiveConfig } from "./config.js";
import type { ArchiveDB, ArchiveChunkRecord } from "./db.js";
import { makeChunkId } from "./db.js";
import type { ArchiveEmbeddings } from "./embeddings.js";
import { extractTopicKeywords } from "./keywords.js";
import type { PluginLogger } from "./types.js";

const JACCARD_THRESHOLD = 0.3;
const MAX_CONSOLIDATED_CHARS = 4096; // ~1024 tokens

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class ChunkConsolidator {
  constructor(
    private db: ArchiveDB,
    private embeddings: ArchiveEmbeddings,
    private config: ContextArchiveConfig,
    private logger: PluginLogger,
  ) {}

  async consolidateIfNeeded(): Promise<{ merged: number }> {
    try {
      const count = this.db.getUnconsolidatedCount();
      if (count < this.config.consolidateAfter) {
        return { merged: 0 };
      }
      return await this.doConsolidate();
    } catch (err) {
      this.logger.warn(`context-archive: consolidation failed: ${String(err)}`);
      return { merged: 0 };
    }
  }

  private async doConsolidate(): Promise<{ merged: number }> {
    const chunks = this.db.getUnconsolidatedChunks(200);
    if (chunks.length === 0) {
      return { merged: 0 };
    }

    // Group by session
    const bySession = new Map<string, ArchiveChunkRecord[]>();
    for (const chunk of chunks) {
      const list = bySession.get(chunk.sessionKey) ?? [];
      list.push(chunk);
      bySession.set(chunk.sessionKey, list);
    }

    let totalMerged = 0;

    for (const [sessionKey, sessionChunks] of bySession) {
      const mergeGroups = this.findMergeGroups(sessionChunks);

      for (const group of mergeGroups) {
        if (group.length < 2) {
          continue;
        }

        // Concatenate texts (capped)
        let mergedText = "";
        for (const chunk of group) {
          if (mergedText.length + chunk.text.length > MAX_CONSOLIDATED_CHARS) {
            break;
          }
          mergedText += (mergedText ? "\n---\n" : "") + chunk.text;
        }

        if (!mergedText) {
          continue;
        }

        // Re-embed merged text
        let embedding: number[];
        try {
          embedding = await this.embeddings.embedQuery(mergedText);
        } catch {
          continue;
        }
        if (embedding.length === 0) {
          continue;
        }

        // Store as new consolidated chunk
        const model = this.config.embedding.model;
        const turnStart = Math.min(...group.map((c) => c.turnStart));
        const turnEnd = Math.max(...group.map((c) => c.turnEnd));
        const startTs = Math.min(...group.map((c) => c.startTs));
        const endTs = Math.max(...group.map((c) => c.endTs));
        const keywords = extractTopicKeywords(mergedText);

        const id = makeChunkId(sessionKey, turnStart, turnEnd, mergedText, model);

        this.db.insertChunk({
          id,
          sessionKey,
          text: mergedText,
          embedding,
          startTs,
          endTs,
          keywords,
          turnStart,
          turnEnd,
          sourceFile: group[0].sourceFile,
          model,
          createdAt: Date.now(),
          consolidated: 0, // The new merged chunk is itself not yet consolidated
        });

        // Mark originals as consolidated (kept but deprioritized)
        this.db.markConsolidated(group.map((c) => c.id));
        totalMerged += group.length;
      }
    }

    if (totalMerged > 0) {
      this.logger.info(`context-archive: consolidated ${totalMerged} chunks`);
    }

    return { merged: totalMerged };
  }

  /**
   * Find groups of chunks that should be merged based on keyword overlap.
   * Simple greedy clustering: iterate chunks, try to merge with existing groups.
   */
  private findMergeGroups(chunks: ArchiveChunkRecord[]): ArchiveChunkRecord[][] {
    const groups: ArchiveChunkRecord[][] = [];

    for (const chunk of chunks) {
      let placed = false;
      for (const group of groups) {
        // Check keyword overlap with any member of the group
        const representative = group[0];
        const similarity = jaccardSimilarity(chunk.keywords, representative.keywords);
        if (similarity >= JACCARD_THRESHOLD) {
          group.push(chunk);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([chunk]);
      }
    }

    return groups;
  }
}
