/**
 * Extracts decisions, entities, and topics from conversation text.
 *
 * All extraction is regex/heuristic-based — no LLM calls, no ML models.
 */

// ---------------------------------------------------------------------------
// Decision extraction
// ---------------------------------------------------------------------------

const DECISION_PATTERN =
  /[^.!?\n]*\b(decided|will use|going with|chose|selected|agreed|confirmed|let's use|we should|switching to|moving to|opting for|prefer|must use|need to use|plan to use|want to use)\b[^.!?\n]*[.!?\n]?/gi;

const LEADING_CONJUNCTION = /^\s*(?:and|but|so)\s+/i;

export function extractDecisions(text: string): string[] {
  const seen = new Set<string>();
  const decisions: string[] = [];

  for (const match of text.matchAll(DECISION_PATTERN)) {
    let stmt = match[0].trim();
    stmt = stmt.replace(LEADING_CONJUNCTION, "").trim();
    if (!stmt) {
      continue;
    }
    const key = stmt.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      decisions.push(stmt);
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

const CAPITALIZED_WORD = /\b([A-Z][a-z]{2,})\b/g;
const MENTION_PATTERN = /@(\w+)/g;
const QUOTED_PATTERN = /"([^"]+)"/g;
const TECH_TERM_PATTERN =
  /\b([a-z]+[A-Z]\w+|[a-z]+_[a-z]+\w*|[A-Z]{2,}[A-Z_]*|[A-Z][a-z]+[A-Z]\w+)\b/g;

const SKIP_WORDS = new Set(["the", "this", "that", "these", "those", "and", "but", "for"]);

function findSentenceStarters(text: string): Set<number> {
  const starters = new Set<number>();
  const first = text.match(/^\s*(\w)/);
  if (first?.index !== undefined) {
    starters.add(first.index + (first[0].length - 1));
  }
  for (const m of text.matchAll(/[.!?]\s+(\w)/g)) {
    if (m.index !== undefined) {
      starters.add(m.index + m[0].length - 1);
    }
  }
  return starters;
}

export function extractEntities(text: string): string[] {
  const seen = new Set<string>();
  const entities: string[] = [];
  const sentenceStarters = findSentenceStarters(text);

  // Capitalized words not at sentence start
  for (const match of text.matchAll(CAPITALIZED_WORD)) {
    const word = match[1];
    if (match.index !== undefined && sentenceStarters.has(match.index)) {
      continue;
    }
    const low = word.toLowerCase();
    if (SKIP_WORDS.has(low)) {
      continue;
    }
    if (!seen.has(low)) {
      seen.add(low);
      entities.push(word);
    }
  }

  // @mentions
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const mention = `@${match[1]}`;
    const low = mention.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      entities.push(mention);
    }
  }

  // Quoted terms
  for (const match of text.matchAll(QUOTED_PATTERN)) {
    const term = match[1].trim();
    const low = term.toLowerCase();
    if (term && !seen.has(low)) {
      seen.add(low);
      entities.push(term);
    }
  }

  // Technical terms (camelCase, snake_case, ALL_CAPS)
  for (const match of text.matchAll(TECH_TERM_PATTERN)) {
    const term = match[1];
    const low = term.toLowerCase();
    if (!seen.has(low) && !SKIP_WORDS.has(low)) {
      seen.add(low);
      entities.push(term);
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

const PREP_TOPIC_PATTERN =
  /\b(?:about|regarding|for|on|with)\s+([A-Z][A-Za-z0-9]*(?:\s+[A-Za-z0-9]+){0,3})/g;

const CAPITALIZED_PHRASE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

export function extractTopics(text: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const match of text.matchAll(PREP_TOPIC_PATTERN)) {
    const phrase = match[1].trim();
    const low = phrase.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      topics.push(phrase);
    }
  }

  for (const match of text.matchAll(CAPITALIZED_PHRASE)) {
    const phrase = match[1].trim();
    const low = phrase.toLowerCase();
    if (!seen.has(low)) {
      seen.add(low);
      topics.push(phrase);
    }
  }

  return topics;
}
