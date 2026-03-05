/**
 * Confidence scoring for agent outputs against the epistemic archive.
 *
 * Scores are computed (not self-reported) by checking the output against
 * archived decisions, entities, and topics. Penalizes gaps, drift, and
 * contradictions.
 */

import { detectContradictions } from "./contradiction-detector.js";
import { extractEntities, extractTopics } from "./decision-extractor.js";
import type { EpistemicArchive } from "./epistemic-archive.js";
import type {
  ConfidenceFlag,
  ConfidenceSignal,
  ContradictionCitation,
  EpistemicConfig,
} from "./epistemic-types.js";

export function scoreConfidence(params: {
  outputText: string;
  currentContextSummary: string | undefined;
  archive: EpistemicArchive;
  config: EpistemicConfig;
}): ConfidenceSignal {
  const { outputText, currentContextSummary, archive, config } = params;

  // 1. Extract entities and topics from the output
  const entities = extractEntities(outputText);
  const topics = extractTopics(outputText);
  const contextLower = (currentContextSummary ?? "").toLowerCase();

  // 2. Detect entity gaps — entity in output but archived context not in current window
  const gaps: string[] = [];
  for (const entity of entities) {
    const results = archive.keywordSearch(entity, 3);
    if (results.length > 0 && contextLower && !contextLower.includes(entity.toLowerCase())) {
      gaps.push(entity);
    }
  }

  // 3. Detect topic drift — topic has archived history but missing from current context
  const driftTopics: string[] = [];
  for (const topic of topics) {
    const results = archive.keywordSearch(topic, 3);
    if (results.length > 0 && contextLower && !contextLower.includes(topic.toLowerCase())) {
      driftTopics.push(topic);
    }
  }

  // 4. Run contradiction detection
  const archivedDecisions = archive.getAllDecisions();
  const contradictions = detectContradictions(outputText, archivedDecisions);

  // 5. Compute score
  let score = 1.0;
  score -= 0.1 * gaps.length;
  score -= 0.2 * contradictions.length;
  score -= 0.05 * driftTopics.length;
  score = Math.max(0, Math.min(1, score));

  // 6. Build flags
  const flags: ConfidenceFlag[] = [];
  if (gaps.length > 0) {
    flags.push("gap");
  }
  if (contradictions.length > 0) {
    flags.push("contradiction");
  }
  if (driftTopics.length > 0) {
    flags.push("drift");
  }

  // 7. Build citations
  const citations: ContradictionCitation[] = contradictions.map((c) => ({
    currentStatement: c.currentStatement,
    archivedStatement: c.archivedStatement,
    chunkId: c.archivedChunk.chunkId,
    sessionId: c.archivedChunk.sessionId,
    turnId: c.archivedChunk.turnId,
    confidence: c.confidence,
  }));

  // 8. Recommendation
  const recommendation = buildRecommendation(score, flags, config);

  return {
    score: Math.round(score * 1000) / 1000,
    flags,
    citations,
    recommendation,
  };
}

function buildRecommendation(
  score: number,
  flags: ConfidenceFlag[],
  config: EpistemicConfig,
): string {
  if (flags.includes("contradiction")) {
    return (
      "CONTRADICTION DETECTED: Output conflicts with prior archived " +
      "decisions. Review citations and reconcile before proceeding."
    );
  }
  if (score < config.hardInterruptThreshold) {
    return (
      "LOW CONFIDENCE: Significant gaps detected between output and " +
      "archived knowledge. Recommend retrieving relevant context."
    );
  }
  if (score < config.softNudgeThreshold) {
    return (
      "MODERATE CONFIDENCE: Some referenced entities or topics lack " +
      "context grounding. Consider verifying against archive."
    );
  }
  return "HIGH CONFIDENCE: Output is well-grounded in available context.";
}
