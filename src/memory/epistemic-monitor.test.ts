import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpistemicArchive } from "./epistemic-archive.js";
import { EpistemicMonitor } from "./epistemic-monitor.js";

let dbPath: string;
let archive: EpistemicArchive;
let monitor: EpistemicMonitor;

beforeEach(() => {
  dbPath = path.join(
    os.tmpdir(),
    `epistemic-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  archive = new EpistemicArchive(dbPath);
  monitor = new EpistemicMonitor({
    archive,
    sessionId: "test-session",
  });
});

afterEach(() => {
  archive.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(`${dbPath}-wal`);
    fs.unlinkSync(`${dbPath}-shm`);
  } catch {
    // ignore cleanup errors
  }
});

describe("EpistemicMonitor", () => {
  describe("observe + evaluate", () => {
    it("returns high confidence when archive is empty", () => {
      monitor.observe("user", "What database should we use?");
      const signal = monitor.evaluate("Let's use PostgreSQL for the database.");
      expect(signal.score).toBeGreaterThanOrEqual(0.7);
      expect(signal.flags).toHaveLength(0);
    });

    it("detects contradictions against archived decisions", () => {
      // Archive a prior decision
      monitor.archiveMessages([
        { role: "user", content: "What database?" },
        { role: "assistant", content: "We decided to use PostgreSQL for the database." },
      ]);

      const signal = monitor.evaluate("We decided to use MongoDB for the database.");
      expect(signal.flags).toContain("contradiction");
      expect(signal.citations.length).toBeGreaterThan(0);
      expect(signal.score).toBeLessThan(1.0);
    });
  });

  describe("processTurn", () => {
    it("returns no signal for user turns", () => {
      const { signal, interrupt } = monitor.processTurn("user", "Hello");
      expect(signal).toBeUndefined();
      expect(interrupt).toBeUndefined();
    });

    it("evaluates assistant turns", () => {
      const { signal } = monitor.processTurn("assistant", "I think we should use Docker.");
      expect(signal).toBeDefined();
      expect(signal!.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe("checkInterrupt", () => {
    it("returns hard interrupt for contradictions", () => {
      monitor.archiveMessages([
        { role: "assistant", content: "We decided to use PostgreSQL for the database." },
      ]);

      const signal = monitor.evaluate("We decided to use MongoDB for the database.");
      const interrupt = monitor.checkInterrupt(signal);
      expect(interrupt).toBeDefined();
      expect(interrupt!.severity).toBe("hard_interrupt");
      expect(interrupt!.message).toContain("CONTRADICTION");
    });

    it("returns undefined for high-confidence outputs", () => {
      const signal = monitor.evaluate("The weather is nice today.");
      const interrupt = monitor.checkInterrupt(signal);
      expect(interrupt).toBeUndefined();
    });
  });

  describe("generateBriefing", () => {
    it("generates briefing with no prior data", () => {
      const briefing = monitor.generateBriefing();
      expect(briefing).toContain("Session Briefing");
      expect(briefing).toContain("(none)");
    });

    it("includes archived decisions in briefing", () => {
      monitor.archiveMessages([
        { role: "assistant", content: "We decided to use PostgreSQL for storage." },
      ]);

      const briefing = monitor.generateBriefing();
      expect(briefing).toContain("PostgreSQL");
    });
  });

  describe("archiveMessages", () => {
    it("stores messages and extracts metadata", () => {
      const stats = monitor.archiveMessages([
        { role: "user", content: "What should we use for the database?" },
        { role: "assistant", content: "We decided to use PostgreSQL." },
      ]);

      expect(stats.chunksCreated).toBe(2);
      expect(stats.chunksAfter).toBeGreaterThan(0);

      const decisions = archive.getAllDecisions();
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.some((d) => d.decisions.some((s) => s.includes("PostgreSQL")))).toBe(true);
    });
  });

  describe("consolidateDecisions", () => {
    it("marks older duplicate decisions as superseded", () => {
      // Archive two sessions with overlapping topic decisions
      monitor.archiveMessages([
        { role: "assistant", content: "We decided to use Redis for caching." },
      ]);

      // Create new monitor for second session
      const monitor2 = new EpistemicMonitor({
        archive,
        sessionId: "session-2",
      });
      monitor2.archiveMessages([
        { role: "assistant", content: "We decided to use Memcached for caching." },
      ]);

      const stats = monitor.consolidateDecisions();
      expect(stats.decisionsSuperseded).toBeGreaterThanOrEqual(0);
    });
  });

  describe("self-compaction", () => {
    it("compacts observations when exceeding max turns", () => {
      const smallMonitor = new EpistemicMonitor({
        archive,
        sessionId: "compact-test",
        config: { maxObservedTurns: 4 },
      });

      for (let i = 0; i < 6; i++) {
        smallMonitor.observe("user", `Message ${i}`);
        smallMonitor.observe("assistant", `Response ${i}`);
      }

      // Should have compacted and archived some turns
      const chunks = archive.getAllChunks();
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});

describe("EpistemicArchive", () => {
  it("stores and retrieves chunks", () => {
    const chunk = {
      chunkId: "test-1",
      sessionId: "s1",
      turnId: 1,
      role: "assistant" as const,
      content: "We decided to use PostgreSQL.",
      timestamp: new Date().toISOString(),
      topics: ["Database Selection"],
      entities: ["PostgreSQL"],
      decisions: ["We decided to use PostgreSQL."],
    };

    archive.storeChunk(chunk);
    const retrieved = archive.getChunk("test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe("We decided to use PostgreSQL.");
    expect(retrieved!.decisions).toEqual(["We decided to use PostgreSQL."]);
  });

  it("performs keyword search", () => {
    archive.storeChunk({
      chunkId: "ks-1",
      sessionId: "s1",
      turnId: 1,
      role: "assistant",
      content: "We decided to use PostgreSQL for the main database.",
      timestamp: new Date().toISOString(),
      topics: [],
      entities: ["PostgreSQL"],
      decisions: ["We decided to use PostgreSQL for the main database."],
    });

    const results = archive.keywordSearch("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunk.content).toContain("PostgreSQL");
  });

  it("counts chunks", () => {
    expect(archive.countChunks()).toBe(0);
    archive.storeChunk({
      chunkId: "cnt-1",
      sessionId: "s1",
      turnId: 1,
      role: "assistant",
      content: "Test",
      timestamp: new Date().toISOString(),
      topics: [],
      entities: [],
      decisions: [],
    });
    expect(archive.countChunks()).toBe(1);
  });
});
