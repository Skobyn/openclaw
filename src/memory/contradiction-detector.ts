/**
 * Rule-based contradiction detection between current output and archived decisions.
 *
 * Uses antonym pairs, negation asymmetry, and conflicting choice patterns.
 * No LLM calls — pure string matching for speed and specificity.
 */

import type { DecisionChunk } from "./epistemic-types.js";

// ---------------------------------------------------------------------------
// Antonym pairs — action verbs / adjectives that indicate opposites
// ---------------------------------------------------------------------------

const ANTONYM_PAIRS: [string, string][] = [
  ["add", "remove"],
  ["enable", "disable"],
  ["use", "avoid"],
  ["include", "exclude"],
  ["allow", "deny"],
  ["start", "stop"],
  ["create", "delete"],
  ["accept", "reject"],
  ["open", "close"],
  ["show", "hide"],
  ["increase", "decrease"],
  ["upgrade", "downgrade"],
  ["connect", "disconnect"],
  ["install", "uninstall"],
  ["activate", "deactivate"],
  ["encrypt", "decrypt"],
  ["require", "optional"],
  ["sync", "async"],
  ["public", "private"],
  ["mutable", "immutable"],
];

const antonymMap = new Map<string, Set<string>>();
for (const [a, b] of ANTONYM_PAIRS) {
  if (!antonymMap.has(a)) {
    antonymMap.set(a, new Set());
  }
  if (!antonymMap.has(b)) {
    antonymMap.set(b, new Set());
  }
  antonymMap.get(a)!.add(b);
  antonymMap.get(b)!.add(a);
}

// ---------------------------------------------------------------------------
// Decision-indicating patterns (mirrors decision-extractor)
// ---------------------------------------------------------------------------

const DECISION_PATTERN =
  /[^.!?\n]*\b(decided|will use|going with|chose|selected|agreed|confirmed|let's use|we should|switching to|moving to|opting for|prefer|must use|need to use|plan to use|want to use)\b[^.!?\n]*[.!?\n]?/gi;

const IMPERATIVE_PATTERN = /(?:^|\n)\s*([A-Z][a-z]+(?:\s+\S+){1,10}[.!])/g;

const NEGATION_WORDS = new Set([
  "not",
  "no",
  "never",
  "don't",
  "doesn't",
  "shouldn't",
  "won't",
  "cannot",
  "can't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "without",
  "neither",
  "nor",
  "avoid",
  "stop",
  "remove",
]);

const LEADING_CONJUNCTION = /^\s*(?:and|but|so)\s+/i;

// ---------------------------------------------------------------------------
// Contradiction result
// ---------------------------------------------------------------------------

export type Contradiction = {
  currentStatement: string;
  archivedStatement: string;
  archivedChunk: DecisionChunk;
  confidence: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectContradictions(
  currentText: string,
  archivedDecisions: DecisionChunk[],
): Contradiction[] {
  const currentStatements = extractStatements(currentText);
  if (currentStatements.length === 0) {
    return [];
  }

  const contradictions: Contradiction[] = [];

  for (const stmt of currentStatements) {
    for (const chunk of archivedDecisions) {
      for (const archivedDecision of chunk.decisions) {
        const [isConflict, confidence] = statementsConflict(stmt, archivedDecision);
        if (isConflict) {
          contradictions.push({
            currentStatement: stmt,
            archivedStatement: archivedDecision,
            archivedChunk: chunk,
            confidence,
          });
        }
      }
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractStatements(text: string): string[] {
  const seen = new Set<string>();
  const statements: string[] = [];

  for (const match of text.matchAll(DECISION_PATTERN)) {
    let stmt = match[0].trim().replace(LEADING_CONJUNCTION, "").trim();
    if (stmt && !seen.has(stmt.toLowerCase())) {
      seen.add(stmt.toLowerCase());
      statements.push(stmt);
    }
  }

  for (const match of text.matchAll(IMPERATIVE_PATTERN)) {
    const stmt = match[1].trim();
    if (stmt && !seen.has(stmt.toLowerCase())) {
      seen.add(stmt.toLowerCase());
      statements.push(stmt);
    }
  }

  return statements;
}

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+/g)].map((m) => m[0]);
}

function hasNegation(words: string[]): boolean {
  return words.some((w) => NEGATION_WORDS.has(w));
}

function antonymScore(words1: string[], words2: string[]): number {
  const set2 = new Set(words2);
  let found = 0;
  for (const w of words1) {
    const antonyms = antonymMap.get(w);
    if (antonyms) {
      for (const ant of antonyms) {
        if (set2.has(ant)) {
          found++;
          break;
        }
      }
    }
  }
  return Math.min(1.0, found);
}

const CHOICE_VERB_PATTERN =
  /\b(use|chose|selected|going with|switch(?:ing)?\s+to|prefer|moving\s+to|opting\s+for)\s+(\S+)/gi;

const CHOICE_VERB_FAMILY = new Set(["use", "chose", "selected", "prefer"]);

function choiceConflictScore(stmt1: string, stmt2: string): number {
  const matches1 = [...stmt1.matchAll(CHOICE_VERB_PATTERN)];
  const matches2 = [...stmt2.matchAll(CHOICE_VERB_PATTERN)];
  if (matches1.length === 0 || matches2.length === 0) {
    return 0;
  }

  for (const [, verb1, obj1] of matches1) {
    for (const [, verb2, obj2] of matches2) {
      const v1 = verb1.toLowerCase().replace(/\s+/g, " ").trim();
      const v2 = verb2.toLowerCase().replace(/\s+/g, " ").trim();
      const o1 = obj1
        .toLowerCase()
        .trim()
        .replace(/[.,!?]$/, "");
      const o2 = obj2
        .toLowerCase()
        .trim()
        .replace(/[.,!?]$/, "");

      const sameFamily = v1 === v2 || (CHOICE_VERB_FAMILY.has(v1) && CHOICE_VERB_FAMILY.has(v2));
      if (sameFamily && o1 !== o2) {
        return 1.0;
      }
    }
  }

  return 0;
}

function statementsConflict(stmt1: string, stmt2: string): [boolean, number] {
  const words1 = tokenize(stmt1);
  const words2 = tokenize(stmt2);
  if (words1.length === 0 || words2.length === 0) {
    return [false, 0];
  }

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let overlapCount = 0;
  for (const w of set1) {
    if (set2.has(w)) {
      overlapCount++;
    }
  }
  const unionSize = new Set([...set1, ...set2]).size;
  if (unionSize === 0) {
    return [false, 0];
  }
  const overlapRatio = overlapCount / unionSize;

  // Need some topical overlap to compare
  if (overlapRatio < 0.1) {
    return [false, 0];
  }

  const negationConflict = hasNegation(words1) !== hasNegation(words2);
  const antonyms = antonymScore(words1, words2);
  const choiceConflict = choiceConflictScore(stmt1, stmt2);

  let conflictSignal = 0;
  if (negationConflict) {
    conflictSignal += 0.5;
  }
  conflictSignal += antonyms * 0.4;
  conflictSignal += choiceConflict * 0.4;

  const confidence = Math.min(1.0, conflictSignal * (0.5 + overlapRatio));
  const rounded = Math.round(confidence * 1000) / 1000;
  return [rounded >= 0.3, rounded];
}
