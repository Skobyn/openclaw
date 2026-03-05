/**
 * Types for the epistemic memory monitor.
 *
 * Ports the dual-agent memory concept: a monitoring layer that detects
 * contradictions and confidence gaps in agent outputs against an archive
 * of prior decisions, entities, and topics.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Core data structures
// ---------------------------------------------------------------------------

export type DecisionChunk = {
  chunkId: string;
  sessionId: string;
  turnId: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  topics: string[];
  entities: string[];
  decisions: string[];
};

export function createDecisionChunk(
  partial: Omit<DecisionChunk, "chunkId" | "timestamp"> & {
    chunkId?: string;
    timestamp?: string;
  },
): DecisionChunk {
  return {
    chunkId: partial.chunkId ?? randomUUID().slice(0, 12),
    timestamp: partial.timestamp ?? new Date().toISOString(),
    ...partial,
  };
}

export type EpistemicSearchResult = {
  chunk: DecisionChunk;
  score: number;
  matchType: "vector" | "keyword" | "hybrid";
};

// ---------------------------------------------------------------------------
// Confidence signal (output of the scorer)
// ---------------------------------------------------------------------------

export type ConfidenceFlag = "contradiction" | "gap" | "drift";

export type ContradictionCitation = {
  currentStatement: string;
  archivedStatement: string;
  chunkId: string;
  sessionId: string;
  turnId: number;
  confidence: number;
};

export type ConfidenceSignal = {
  score: number;
  flags: ConfidenceFlag[];
  citations: ContradictionCitation[];
  recommendation: string;
};

// ---------------------------------------------------------------------------
// Interrupt (decision from the monitor)
// ---------------------------------------------------------------------------

export type InterruptSeverity = "soft_nudge" | "hard_interrupt";

export type EpistemicInterrupt = {
  severity: InterruptSeverity;
  message: string;
  contradictingChunks: DecisionChunk[];
  suggestedQuery: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type EpistemicConfig = {
  /** Confidence below this triggers a hard interrupt. */
  hardInterruptThreshold: number;
  /** Confidence below this triggers a soft nudge. */
  softNudgeThreshold: number;
  /** Max search results per query. */
  searchTopK: number;
  /** Max observed turns before the monitor self-compacts. */
  maxObservedTurns: number;
};

export const DEFAULT_EPISTEMIC_CONFIG: EpistemicConfig = {
  hardInterruptThreshold: 0.5,
  softNudgeThreshold: 0.7,
  searchTopK: 5,
  maxObservedTurns: 50,
};
