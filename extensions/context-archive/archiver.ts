/**
 * Core archive pipeline — runs on before_compaction and before_reset hooks.
 *
 * Deterministically captures, chunks, embeds, and indexes the full conversation
 * before it's summarized away by compaction.
 */

import type { ContextArchiveConfig } from "./config.js";
import { vectorDimsForModel } from "./config.js";
import type { ArchiveDB } from "./db.js";
import { makeChunkId } from "./db.js";
import type { ArchiveEmbeddings } from "./embeddings.js";
import { groupIntoTurns, chunkConversation } from "./chunker.js";
import type { PluginLogger } from "./types.js";

const EMBED_TIMEOUT_MS = 30_000;

export class ContextArchiver {
  constructor(
    private db: ArchiveDB,
    private embeddings: ArchiveEmbeddings,
    private config: ContextArchiveConfig,
    private logger: PluginLogger,
  ) {}

  async archiveMessages(params: {
    messages: unknown[];
    sessionKey: string;
    sessionFile?: string;
  }): Promise<{ chunksStored: number }> {
    try {
      return await this.doArchive(params);
    } catch (err) {
      // Must never crash the compaction flow
      this.logger.warn(`context-archive: archive failed: ${String(err)}`);
      return { chunksStored: 0 };
    }
  }

  private async doArchive(params: {
    messages: unknown[];
    sessionKey: string;
    sessionFile?: string;
  }): Promise<{ chunksStored: number }> {
    const { messages, sessionKey, sessionFile } = params;

    if (!messages || messages.length === 0) {
      return { chunksStored: 0 };
    }

    // 1. Group into turns
    const turns = groupIntoTurns(messages);
    if (turns.length === 0) {
      return { chunksStored: 0 };
    }

    // 2. Check last archived offset — skip already-archived turns
    const lastOffset = this.db.getLastArchivedOffset(sessionKey);
    const newTurns = turns.filter((t) => t.turnIndex > lastOffset);
    if (newTurns.length === 0) {
      return { chunksStored: 0 };
    }

    // 3. Chunk
    const chunks = chunkConversation(newTurns, {
      maxTokens: this.config.chunkTokens,
      overlap: 1,
    });
    if (chunks.length === 0) {
      return { chunksStored: 0 };
    }

    // 4. Embed with timeout
    const model = this.config.embedding.model;
    let embeddings: number[][];
    try {
      embeddings = await Promise.race([
        this.embeddings.embedBatch(chunks.map((c) => c.text)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Embedding timeout")), EMBED_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      this.logger.warn(`context-archive: embedding failed: ${String(err)}`);
      return { chunksStored: 0 };
    }

    // 5. Store chunks
    const now = Date.now();
    let stored = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      if (!embedding || embedding.length === 0) {
        continue;
      }

      const id = makeChunkId(sessionKey, chunk.turnStart, chunk.turnEnd, chunk.text, model);

      this.db.insertChunk({
        id,
        sessionKey,
        text: chunk.text,
        embedding,
        startTs: chunk.startTs,
        endTs: chunk.endTs,
        keywords: chunk.keywords,
        turnStart: chunk.turnStart,
        turnEnd: chunk.turnEnd,
        sourceFile: sessionFile,
        model,
        createdAt: now,
        consolidated: 0,
      });
      stored++;
    }

    // 6. Update offset
    const latestTurnIndex = Math.max(...newTurns.map((t) => t.turnIndex));
    this.db.setLastArchivedOffset(sessionKey, latestTurnIndex);

    if (stored > 0) {
      this.logger.info(
        `context-archive: archived ${stored} chunks for session ${sessionKey.slice(0, 12)}...`,
      );
    }

    return { chunksStored: stored };
  }
}
