/**
 * Epistemic monitor — the orchestrator that observes conversation turns,
 * evaluates agent outputs against the archive, and raises interrupts
 * when contradictions or confidence gaps are detected.
 *
 * This is the "Memory Agent" from the dual-agent architecture, ported
 * to TypeScript and wired into clawdbot's existing memory infrastructure.
 */

import { scoreConfidence } from "./confidence-scorer.js";
import { extractDecisions, extractEntities, extractTopics } from "./decision-extractor.js";
import type { EpistemicArchive } from "./epistemic-archive.js";
import type {
  ConfidenceSignal,
  DecisionChunk,
  EpistemicConfig,
  EpistemicInterrupt,
} from "./epistemic-types.js";
import { createDecisionChunk, DEFAULT_EPISTEMIC_CONFIG } from "./epistemic-types.js";

const LEADING_CONJUNCTION = /^\s*(?:and|but|so)\s+/i;

// Patterns for decision extraction (used in self-compaction)
const DECISION_PATTERN =
  /[^.!?\n]*\b(decided|will use|going with|chose|selected|agreed|confirmed|let's use|we should|switching to|moving to|opting for|prefer|must use|need to use|plan to use|want to use)\b[^.!?\n]*[.!?\n]?/gi;

type ObservedTurn = { role: string; content: string };

export class EpistemicMonitor {
  private archive: EpistemicArchive;
  private config: EpistemicConfig;
  private observedTurns: ObservedTurn[] = [];
  private rollingSummary = "";
  private sessionId: string;

  constructor(params: {
    archive: EpistemicArchive;
    sessionId: string;
    config?: Partial<EpistemicConfig>;
  }) {
    this.archive = params.archive;
    this.sessionId = params.sessionId;
    this.config = { ...DEFAULT_EPISTEMIC_CONFIG, ...params.config };
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Record a conversation turn. Called for every message (user/assistant/system).
   */
  observe(role: string, content: string): void {
    this.observedTurns.push({ role, content });
    this.compactObservations();
  }

  /**
   * Evaluate the latest assistant output against the archive.
   * Returns a confidence signal with score, flags, and citations.
   */
  evaluate(assistantOutput: string): ConfidenceSignal {
    const contextSummary = this.buildContextSummary();
    return scoreConfidence({
      outputText: assistantOutput,
      currentContextSummary: contextSummary,
      archive: this.archive,
      config: this.config,
    });
  }

  /**
   * Decide whether to raise an interrupt based on a confidence signal.
   */
  checkInterrupt(signal: ConfidenceSignal): EpistemicInterrupt | undefined {
    const contradictingChunks: DecisionChunk[] = [];
    for (const citation of signal.citations) {
      const chunk = this.archive.getChunk(citation.chunkId);
      if (chunk) {
        contradictingChunks.push(chunk);
      }
    }

    // Contradiction flag always triggers hard interrupt
    if (signal.flags.includes("contradiction")) {
      const parts = ["CONTRADICTION: Output conflicts with archived decisions."];
      for (const citation of signal.citations) {
        parts.push(
          `  - Current: "${citation.currentStatement}"` +
            ` vs Archived: "${citation.archivedStatement}"` +
            ` (Session ${citation.sessionId}, Turn ${citation.turnId})`,
        );
      }
      return {
        severity: "hard_interrupt",
        message: parts.join("\n"),
        contradictingChunks,
        suggestedQuery: suggestQuery(signal),
      };
    }

    // Very low score triggers hard interrupt
    if (signal.score < this.config.hardInterruptThreshold) {
      return {
        severity: "hard_interrupt",
        message:
          `LOW CONFIDENCE (${signal.score.toFixed(2)}): Significant knowledge ` +
          `gaps detected. Flags: ${signal.flags.join(", ")}. ` +
          signal.recommendation,
        contradictingChunks,
        suggestedQuery: suggestQuery(signal),
      };
    }

    // Moderate score triggers soft nudge
    if (signal.score < this.config.softNudgeThreshold) {
      return {
        severity: "soft_nudge",
        message:
          `MODERATE CONFIDENCE (${signal.score.toFixed(2)}): ` +
          `Flags: ${signal.flags.join(", ")}. ` +
          signal.recommendation,
        contradictingChunks,
        suggestedQuery: suggestQuery(signal),
      };
    }

    return undefined;
  }

  /**
   * Convenience: observe + evaluate (if assistant) + check interrupt.
   */
  processTurn(
    role: string,
    content: string,
  ): { signal: ConfidenceSignal | undefined; interrupt: EpistemicInterrupt | undefined } {
    this.observe(role, content);

    if (role !== "assistant") {
      return { signal: undefined, interrupt: undefined };
    }

    const signal = this.evaluate(content);
    const interrupt = this.checkInterrupt(signal);
    return { signal, interrupt };
  }

  /**
   * Generate a session-start briefing from the archive.
   */
  generateBriefing(): string {
    const allDecisionChunks = this.archive.getAllDecisions();
    const recentDecisionChunks = allDecisionChunks.slice(-20);

    const allTopics = new Map<string, string>();
    const allEntities = new Map<string, string>();

    for (const chunk of allDecisionChunks) {
      for (const topic of chunk.topics) {
        allTopics.set(topic, chunk.sessionId);
      }
      for (const entity of chunk.entities) {
        allEntities.set(entity, `Last seen in session ${chunk.sessionId}, turn ${chunk.turnId}`);
      }
    }

    const lines: string[] = [];
    lines.push("=== Session Briefing ===");

    lines.push("Prior Decisions:");
    if (recentDecisionChunks.length > 0) {
      for (const chunk of recentDecisionChunks) {
        for (const decision of chunk.decisions) {
          lines.push(`- ${decision} (Session ${chunk.sessionId}, Turn ${chunk.turnId})`);
        }
      }
    } else {
      lines.push("- (none)");
    }

    lines.push(
      `Active Topics: ${allTopics.size > 0 ? JSON.stringify([...allTopics.keys()]) : "(none)"}`,
    );

    lines.push("Key Entities:");
    if (allEntities.size > 0) {
      for (const [entity, state] of allEntities) {
        lines.push(`- ${entity}: ${state}`);
      }
    } else {
      lines.push("- (none)");
    }

    lines.push("===");
    return lines.join("\n");
  }

  /**
   * Archive a batch of messages (e.g., before compaction).
   * Extracts decisions/entities/topics and stores in the archive.
   */
  archiveMessages(messages: Array<{ role: string; content: string }>): {
    chunksCreated: number;
    chunksBefore: number;
    chunksAfter: number;
  } {
    const chunksBefore = this.archive.countChunks();

    const chunks: DecisionChunk[] = messages.map((msg, i) =>
      createDecisionChunk({
        sessionId: this.sessionId,
        turnId: i + 1,
        role: msg.role as DecisionChunk["role"],
        content: msg.content,
        topics: extractTopics(msg.content),
        entities: extractEntities(msg.content),
        decisions: extractDecisions(msg.content),
      }),
    );

    this.archive.storeChunks(chunks);
    const chunksAfter = this.archive.countChunks();

    return { chunksCreated: chunks.length, chunksBefore, chunksAfter };
  }

  /**
   * Consolidate decisions: mark older duplicate decisions as superseded.
   */
  consolidateDecisions(sessionId?: string): {
    topicsConsolidated: number;
    decisionsSuperseded: number;
    decisionsActive: number;
  } {
    let allDecisionChunks = this.archive.getAllDecisions();
    if (sessionId) {
      allDecisionChunks = allDecisionChunks.filter((c) => c.sessionId === sessionId);
    }

    if (allDecisionChunks.length === 0) {
      return { topicsConsolidated: 0, decisionsSuperseded: 0, decisionsActive: 0 };
    }

    // Group by normalized topic
    const topicGroups = new Map<string, DecisionChunk[]>();
    for (const chunk of allDecisionChunks) {
      if (chunk.topics.length > 0) {
        for (const topic of chunk.topics) {
          const key = topic.toLowerCase();
          if (!topicGroups.has(key)) {
            topicGroups.set(key, []);
          }
          topicGroups.get(key)!.push(chunk);
        }
      } else {
        const key = "__no_topic__";
        if (!topicGroups.has(key)) {
          topicGroups.set(key, []);
        }
        topicGroups.get(key)!.push(chunk);
      }
    }

    const supersededIds = new Set<string>();
    let topicsConsolidated = 0;

    for (const [, group] of topicGroups) {
      if (group.length < 2) {
        continue;
      }

      group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const newest = group[group.length - 1];

      for (const older of group.slice(0, -1)) {
        if (supersededIds.has(older.chunkId)) {
          continue;
        }
        if (older.content.startsWith("[SUPERSEDED")) {
          continue;
        }

        older.content = `[SUPERSEDED by ${newest.chunkId}] ${older.content}`;
        this.archive.storeChunk(older);
        supersededIds.add(older.chunkId);
      }

      topicsConsolidated++;
    }

    const decisionsActive = new Set(
      allDecisionChunks.filter((c) => !supersededIds.has(c.chunkId)).map((c) => c.chunkId),
    ).size;

    return {
      topicsConsolidated,
      decisionsSuperseded: supersededIds.size,
      decisionsActive,
    };
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private buildContextSummary(): string {
    const recent = this.observedTurns.slice(-10);
    const parts: string[] = [];

    if (this.rollingSummary) {
      parts.push(`[compacted history]\n${this.rollingSummary}`);
    }

    for (const turn of recent) {
      parts.push(`[${turn.role}]: ${turn.content}`);
    }

    return parts.join("\n");
  }

  private compactObservations(): void {
    if (this.observedTurns.length <= this.config.maxObservedTurns) {
      return;
    }

    const midpoint = Math.floor(this.observedTurns.length / 2);
    const oldTurns = this.observedTurns.slice(0, midpoint);

    // Build structured summary
    const roleCounts = new Map<string, number>();
    const allDecisions: string[] = [];
    const allEntities = new Set<string>();
    const allTopics = new Set<string>();

    for (const turn of oldTurns) {
      roleCounts.set(turn.role, (roleCounts.get(turn.role) ?? 0) + 1);

      if (turn.role === "assistant") {
        for (const match of turn.content.matchAll(DECISION_PATTERN)) {
          let sentence = match[0].trim().replace(LEADING_CONJUNCTION, "").trim();
          if (sentence && !allDecisions.includes(sentence)) {
            allDecisions.push(sentence);
          }
        }
      }

      for (const e of extractEntities(turn.content)) {
        allEntities.add(e);
      }
      for (const t of extractTopics(turn.content)) {
        allTopics.add(t);
      }
    }

    const summaryLines: string[] = [];
    const roleParts = [...roleCounts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([r, c]) => `${r}: ${c}`)
      .join(", ");
    summaryLines.push(`Compacted ${oldTurns.length} turns (${roleParts}).`);

    if (allDecisions.length > 0) {
      summaryLines.push(`Decisions: ${allDecisions.join("; ")}`);
    }
    if (allEntities.size > 0) {
      summaryLines.push(`Entities: ${[...allEntities].toSorted().join(", ")}`);
    }
    if (allTopics.size > 0) {
      summaryLines.push(`Topics: ${[...allTopics].toSorted().join(", ")}`);
    }

    const block = summaryLines.join("\n");
    this.rollingSummary = this.rollingSummary ? `${this.rollingSummary}\n---\n${block}` : block;

    // Archive the compacted turns
    const chunks: DecisionChunk[] = oldTurns.map((turn, i) =>
      createDecisionChunk({
        sessionId: `compaction-${this.sessionId}`,
        turnId: i + 1,
        role: turn.role as DecisionChunk["role"],
        content: turn.content,
        topics: extractTopics(turn.content),
        entities: extractEntities(turn.content),
        decisions: extractDecisions(turn.content),
      }),
    );
    this.archive.storeChunks(chunks);

    // Drop compacted turns
    this.observedTurns = this.observedTurns.slice(midpoint);
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function suggestQuery(signal: ConfidenceSignal): string {
  const suggestions: string[] = [];

  if (signal.citations.length > 0) {
    const stmt = signal.citations[0].currentStatement;
    const words = stmt
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 3 &&
          !["will", "have", "that", "this", "with", "from", "should", "would", "could"].includes(
            w.toLowerCase(),
          ),
      )
      .slice(0, 5);
    suggestions.push(...words);
  }

  if (signal.flags.includes("gap")) {
    suggestions.push("context gaps");
  }
  if (signal.flags.includes("drift")) {
    suggestions.push("topic history");
  }

  return suggestions.length > 0 ? suggestions.join(" ") : "recent decisions";
}
