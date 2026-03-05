import { describe, expect, it } from "vitest";
import { extractDecisions, extractEntities, extractTopics } from "./decision-extractor.js";

describe("extractDecisions", () => {
  it("extracts decision-indicating phrases", () => {
    const text =
      "We decided to use PostgreSQL for the database. " + "Also, we chose Redis for caching.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBe(2);
    expect(decisions[0]).toContain("PostgreSQL");
    expect(decisions[1]).toContain("Redis");
  });

  it("extracts 'going with' and 'will use' patterns", () => {
    const text = "We're going with TypeScript. We will use Vitest for testing.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBe(2);
  });

  it("strips leading conjunctions", () => {
    const text = "And we decided to use Docker.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBe(1);
    expect(decisions[0]).not.toMatch(/^and/i);
  });

  it("deduplicates decisions with identical text", () => {
    const text = "We decided to use X. We decided to use X.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBe(1);
  });

  it("returns empty for text without decisions", () => {
    const text = "The weather is nice today. Let me check the time.";
    expect(extractDecisions(text)).toHaveLength(0);
  });
});

describe("extractEntities", () => {
  it("extracts capitalized and mixed-case tech words", () => {
    const text = "I think PostgreSQL is better than MySQL for this project.";
    const entities = extractEntities(text);
    // PostgreSQL and MySQL are mixed-case tech terms (PascalCase + uppercase segments)
    expect(entities).toContain("PostgreSQL");
    expect(entities).toContain("MySQL");
  });

  it("extracts @mentions", () => {
    const text = "Ask @alice and @bob about the deployment.";
    const entities = extractEntities(text);
    expect(entities).toContain("@alice");
    expect(entities).toContain("@bob");
  });

  it("extracts quoted terms", () => {
    const text = 'The "memory agent" uses "hybrid search" for retrieval.';
    const entities = extractEntities(text);
    expect(entities).toContain("memory agent");
    expect(entities).toContain("hybrid search");
  });

  it("extracts technical terms", () => {
    const text = "The camelCase variable and snake_case function work with ALL_CAPS constants.";
    const entities = extractEntities(text);
    expect(entities.some((e) => e === "camelCase")).toBe(true);
    expect(entities.some((e) => e === "snake_case")).toBe(true);
    expect(entities.some((e) => e === "ALL_CAPS")).toBe(true);
  });

  it("skips sentence-starting words", () => {
    const text = "Docker is great. It simplifies deployment.";
    // "Docker" starts a sentence, should be skipped by capitalized-word extractor
    // but "It" also starts a sentence
    const entities = extractEntities(text);
    expect(entities).not.toContain("It");
  });
});

describe("extractTopics", () => {
  it("extracts phrases after prepositions", () => {
    const text = "We're talking about Database Selection and regarding Cloud Migration.";
    const topics = extractTopics(text);
    expect(topics.some((t) => t.includes("Database"))).toBe(true);
    expect(topics.some((t) => t.includes("Cloud"))).toBe(true);
  });

  it("extracts multi-word capitalized phrases", () => {
    const text = "The Google Cloud Platform and Amazon Web Services are both options.";
    const topics = extractTopics(text);
    expect(topics.some((t) => t.includes("Google Cloud Platform"))).toBe(true);
    expect(topics.some((t) => t.includes("Amazon Web Services"))).toBe(true);
  });

  it("deduplicates topics with same captured phrase", () => {
    const text = "We discussed Google Cloud Platform. Then reviewed Google Cloud Platform.";
    const topics = extractTopics(text);
    // The capitalized-phrase pattern captures "Google Cloud Platform" twice but dedupes
    const gcpTopics = topics.filter((t) => t === "Google Cloud Platform");
    expect(gcpTopics.length).toBe(1);
  });
});
