import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveStore } from "./archive-store.js";

let store: ArchiveStore;
let dbPath: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-archive-test-"));
  dbPath = path.join(tmpDir, "test.sqlite");
  store = new ArchiveStore(dbPath);
});

afterEach(() => {
  store.close();
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

describe("ArchiveStore", () => {
  it("stores and counts chunks", () => {
    store.store({
      sessionId: "s1",
      role: "user",
      content: "We decided to use PostgreSQL.",
      topics: ["database"],
      entities: ["PostgreSQL"],
      decisions: ["use PostgreSQL"],
      embedding: null,
    });
    expect(store.count()).toBe(1);
  });

  it("stores batch and counts", () => {
    const chunks = [
      {
        sessionId: "s1",
        role: "user" as const,
        content: "Let's use Redis for caching.",
        topics: ["caching"],
        entities: ["Redis"],
        decisions: ["use Redis"],
        embedding: null,
      },
      {
        sessionId: "s1",
        role: "assistant" as const,
        content: "Good choice. Redis is fast.",
        topics: ["caching"],
        entities: ["Redis"],
        decisions: [],
        embedding: null,
      },
    ];
    store.storeBatch(chunks);
    expect(store.count()).toBe(2);
  });

  it("performs keyword search via FTS", () => {
    store.store({
      sessionId: "s1",
      role: "user",
      content: "We should migrate to TypeScript for better type safety.",
      topics: ["migration"],
      entities: ["TypeScript"],
      decisions: ["migrate to TypeScript"],
      embedding: null,
    });
    store.store({
      sessionId: "s1",
      role: "user",
      content: "The weather forecast looks sunny today.",
      topics: [],
      entities: [],
      decisions: [],
      embedding: null,
    });

    const results = store.keywordSearch("TypeScript", 5);
    expect(results.length).toBe(1);
    expect(results[0].chunk.content).toContain("TypeScript");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("performs vector search with cosine similarity", () => {
    // Store chunks with fake embeddings
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Database discussion about PostgreSQL.",
      topics: ["database"],
      entities: ["PostgreSQL"],
      decisions: [],
      embedding: [1, 0, 0, 0],
    });
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Frontend work with React components.",
      topics: ["frontend"],
      entities: ["React"],
      decisions: [],
      embedding: [0, 1, 0, 0],
    });
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Another database topic about indexes.",
      topics: ["database"],
      entities: [],
      decisions: [],
      embedding: [0.9, 0.1, 0, 0],
    });

    // Query similar to database (close to [1,0,0,0])
    const results = store.vectorSearch([0.95, 0.05, 0, 0], 5, 0.5);
    expect(results.length).toBe(2); // Both database chunks
    expect(results[0].chunk.content).toContain("PostgreSQL");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects minScore filter in vector search", () => {
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Very relevant content.",
      topics: [],
      entities: [],
      decisions: [],
      embedding: [1, 0, 0],
    });
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Not relevant at all.",
      topics: [],
      entities: [],
      decisions: [],
      embedding: [0, 0, 1],
    });

    const results = store.vectorSearch([1, 0, 0], 10, 0.8);
    expect(results.length).toBe(1);
    expect(results[0].chunk.content).toBe("Very relevant content.");
  });

  it("respects topK limit in vector search", () => {
    for (let i = 0; i < 10; i++) {
      store.store({
        sessionId: "s1",
        role: "user",
        content: `Chunk number ${i}`,
        topics: [],
        entities: [],
        decisions: [],
        embedding: [1, 0, 0],
      });
    }

    const results = store.vectorSearch([1, 0, 0], 3, 0);
    expect(results.length).toBe(3);
  });

  it("skips chunks without embeddings in vector search", () => {
    store.store({
      sessionId: "s1",
      role: "user",
      content: "Has embedding.",
      topics: [],
      entities: [],
      decisions: [],
      embedding: [1, 0, 0],
    });
    store.store({
      sessionId: "s1",
      role: "user",
      content: "No embedding.",
      topics: [],
      entities: [],
      decisions: [],
      embedding: null,
    });

    const results = store.vectorSearch([1, 0, 0], 10, 0);
    expect(results.length).toBe(1);
    expect(results[0].chunk.content).toBe("Has embedding.");
  });
});
