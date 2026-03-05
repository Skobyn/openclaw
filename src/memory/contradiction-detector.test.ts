import { describe, expect, it } from "vitest";
import { detectContradictions } from "./contradiction-detector.js";
import { createDecisionChunk } from "./epistemic-types.js";

function makeDecisionChunk(decision: string, sessionId = "session-1", turnId = 1) {
  return createDecisionChunk({
    sessionId,
    turnId,
    role: "assistant",
    content: decision,
    decisions: [decision],
    topics: [],
    entities: [],
  });
}

describe("detectContradictions", () => {
  it("detects 'use X' vs 'use Y' choice conflicts", () => {
    const archived = [makeDecisionChunk("We decided to use PostgreSQL for the database.")];
    const current = "We decided to use MongoDB for the database.";

    const contradictions = detectContradictions(current, archived);
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].confidence).toBeGreaterThan(0);
  });

  it("detects negation asymmetry", () => {
    const archived = [makeDecisionChunk("We should use caching for performance.")];
    const current = "We should not use caching for this system.";

    const contradictions = detectContradictions(current, archived);
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
  });

  it("detects antonym-based contradictions", () => {
    const archived = [makeDecisionChunk("We decided to enable logging for the service.")];
    const current = "We decided to disable logging for the service.";

    const contradictions = detectContradictions(current, archived);
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no contradictions exist", () => {
    const archived = [makeDecisionChunk("We decided to use PostgreSQL.")];
    const current = "The PostgreSQL setup is progressing well.";

    const contradictions = detectContradictions(current, archived);
    expect(contradictions).toHaveLength(0);
  });

  it("returns empty for unrelated topics", () => {
    const archived = [makeDecisionChunk("We decided to use PostgreSQL for the database.")];
    const current = "The weather forecast shows rain tomorrow.";

    const contradictions = detectContradictions(current, archived);
    expect(contradictions).toHaveLength(0);
  });

  it("handles empty archived decisions", () => {
    const contradictions = detectContradictions("We decided to use X.", []);
    expect(contradictions).toHaveLength(0);
  });

  it("handles text without decision-like statements", () => {
    const archived = [makeDecisionChunk("We decided to use PostgreSQL.")];
    const contradictions = detectContradictions("Hello, how are you?", archived);
    expect(contradictions).toHaveLength(0);
  });

  it("includes archived chunk reference in contradictions", () => {
    const chunk = makeDecisionChunk("We chose Redis for caching.", "s1", 5);
    const contradictions = detectContradictions("We chose Memcached for caching.", [chunk]);
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].archivedChunk.sessionId).toBe("s1");
    expect(contradictions[0].archivedChunk.turnId).toBe(5);
  });
});
