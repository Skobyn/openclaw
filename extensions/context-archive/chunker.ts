/**
 * Turn-aware conversation chunking.
 *
 * Groups messages into user->assistant turn pairs, then chunks
 * turns into archive-sized pieces with overlap.
 */

import { extractTopicKeywords } from "./keywords.js";

export type ConversationTurn = {
  turnIndex: number;
  messages: Array<{ role: string; text: string; timestamp?: number }>;
  combinedText: string;
  estimatedTokens: number;
};

export type ArchiveChunk = {
  text: string;
  turnStart: number;
  turnEnd: number;
  startTs: number;
  endTs: number;
  keywords: string[];
};

/**
 * Extract text from message content, handling both string and content-block formats.
 * Mirrors the logic from src/memory/session-files.ts:extractSessionText().
 */
function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown; name?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      const trimmed = rec.text.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
    // Tool use markers
    if (rec.type === "tool_use" && typeof rec.name === "string") {
      parts.push(`[Tool: ${rec.name}]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Group messages into user->assistant turn pairs.
 * Each turn starts with a user message and includes all subsequent
 * assistant/tool messages until the next user message.
 */
export function groupIntoTurns(messages: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  let turnIndex = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role as string | undefined;
    if (!role) {
      continue;
    }

    const content = msgObj.content;
    const timestamp = typeof msgObj.timestamp === "number" ? msgObj.timestamp : undefined;

    if (role === "user") {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn);
      }
      const text = extractText(content);
      currentTurn = {
        turnIndex,
        messages: [],
        combinedText: "",
        estimatedTokens: 0,
      };
      if (text) {
        currentTurn.messages.push({ role: "user", text, timestamp });
        currentTurn.combinedText = `[USER] ${text}`;
      }
      turnIndex++;
    } else if (role === "assistant") {
      const text = extractText(content);
      if (text && currentTurn) {
        currentTurn.messages.push({ role: "assistant", text, timestamp });
        currentTurn.combinedText += `\n[ASSISTANT] ${text}`;
      } else if (text && !currentTurn) {
        // Assistant message without preceding user message (e.g. system response)
        currentTurn = {
          turnIndex,
          messages: [{ role: "assistant", text, timestamp }],
          combinedText: `[ASSISTANT] ${text}`,
          estimatedTokens: 0,
        };
        turnIndex++;
      }
    }
    // Skip tool_result messages but include their tool name markers via extractText
  }

  // Push final turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  // Compute token estimates
  for (const turn of turns) {
    turn.estimatedTokens = estimateTokens(turn.combinedText);
  }

  return turns;
}

/**
 * Chunk conversation turns into archive-sized pieces.
 *
 * Uses a sliding window: accumulates turns until the combined text
 * exceeds maxTokens, then flushes as a chunk. Keeps the last turn
 * as overlap for the next chunk.
 */
export function chunkConversation(
  turns: ConversationTurn[],
  opts: { maxTokens: number; overlap?: number },
): ArchiveChunk[] {
  if (turns.length === 0) {
    return [];
  }

  const maxChars = opts.maxTokens * 4;
  const overlap = opts.overlap ?? 1;
  const chunks: ArchiveChunk[] = [];

  let buffer: ConversationTurn[] = [];
  let bufferChars = 0;

  function flushBuffer(): void {
    if (buffer.length === 0) {
      return;
    }

    const text = buffer.map((t) => t.combinedText).join("\n");
    const timestamps = buffer.flatMap((t) =>
      t.messages.filter((m) => m.timestamp != null).map((m) => m.timestamp!),
    );
    const startTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const endTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

    chunks.push({
      text,
      turnStart: buffer[0].turnIndex,
      turnEnd: buffer[buffer.length - 1].turnIndex,
      startTs,
      endTs,
      keywords: extractTopicKeywords(text),
    });
  }

  for (const turn of turns) {
    const turnChars = turn.combinedText.length;

    // If a single turn exceeds the limit, split it within
    if (turnChars > maxChars) {
      // Flush current buffer first
      flushBuffer();
      buffer = [];
      bufferChars = 0;

      // Split the large turn into line-based sub-chunks
      const lines = turn.combinedText.split("\n");
      let subText = "";
      for (const line of lines) {
        if (subText.length + line.length + 1 > maxChars && subText.length > 0) {
          const timestamps = turn.messages
            .filter((m) => m.timestamp != null)
            .map((m) => m.timestamp!);
          chunks.push({
            text: subText,
            turnStart: turn.turnIndex,
            turnEnd: turn.turnIndex,
            startTs: timestamps.length > 0 ? Math.min(...timestamps) : 0,
            endTs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
            keywords: extractTopicKeywords(subText),
          });
          subText = "";
        }
        subText += (subText ? "\n" : "") + line;
      }
      if (subText) {
        const timestamps = turn.messages
          .filter((m) => m.timestamp != null)
          .map((m) => m.timestamp!);
        chunks.push({
          text: subText,
          turnStart: turn.turnIndex,
          turnEnd: turn.turnIndex,
          startTs: timestamps.length > 0 ? Math.min(...timestamps) : 0,
          endTs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
          keywords: extractTopicKeywords(subText),
        });
      }
      continue;
    }

    if (bufferChars + turnChars > maxChars && buffer.length > 0) {
      flushBuffer();
      // Keep last `overlap` turns for context continuity
      const overlapTurns = buffer.slice(-overlap);
      buffer = overlapTurns;
      bufferChars = overlapTurns.reduce((sum, t) => sum + t.combinedText.length, 0);
    }

    buffer.push(turn);
    bufferChars += turnChars;
  }

  // Flush remaining
  flushBuffer();

  return chunks;
}
