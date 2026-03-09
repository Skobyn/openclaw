/**
 * Topic keyword extraction without LLM calls.
 *
 * Strategy: tokenize, remove stop words, count frequencies,
 * boost tool names / file paths / code identifiers, return top N.
 */

const STOP_WORDS = new Set([
  // Articles and determiners
  "a", "an", "the", "this", "that", "these", "those",
  // Pronouns
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they", "them",
  // Common verbs
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about", "into",
  "through", "during", "before", "after", "above", "below", "between", "under", "over",
  // Conjunctions
  "and", "or", "but", "if", "then", "because", "as", "while", "when", "where",
  "what", "which", "who", "how", "why",
  // Time references
  "yesterday", "today", "tomorrow", "earlier", "later", "recently", "ago", "just", "now",
  // Vague references
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  // Request words
  "please", "help", "find", "show", "get", "tell", "give",
  // Common filler
  "also", "very", "really", "here", "there", "so", "too", "not", "no", "yes",
  "ok", "okay", "sure", "right", "well", "just", "like", "know", "think", "want",
  "need", "use", "using", "used", "make", "made", "let", "see", "look", "try",
]);

/** Detect tool-like names (underscored lowercase, e.g. memory_store) */
function isToolName(token: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token);
}

/** Detect file paths (contain / or common extensions) */
function isFilePath(token: string): boolean {
  return /[/\\]/.test(token) || /\.\w{1,5}$/.test(token);
}

/** Detect code identifiers (camelCase or PascalCase) */
function isCodeIdentifier(token: string): boolean {
  return /^[a-z]+[A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token);
}

export function extractTopicKeywords(text: string, maxKeywords = 5): string[] {
  // Tokenize: split on whitespace and punctuation, keeping meaningful tokens
  const raw = text.toLowerCase().replace(/[^\w\s/\\.@_-]/g, " ");
  const tokens = raw.split(/\s+/).filter((t) => t.length > 1);

  const freq = new Map<string, number>();
  const boost = new Map<string, number>();

  for (const token of tokens) {
    if (STOP_WORDS.has(token)) {
      continue;
    }
    // Skip pure numbers
    if (/^\d+$/.test(token)) {
      continue;
    }
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  // Also extract from the original (non-lowered) text for case-sensitive patterns
  const origTokens = text.replace(/[^\w\s/\\.@_-]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  for (const token of origTokens) {
    const lower = token.toLowerCase();
    if (!freq.has(lower)) {
      continue;
    }
    if (isToolName(lower)) {
      boost.set(lower, (boost.get(lower) ?? 0) + 3);
    }
    if (isFilePath(token)) {
      boost.set(lower, (boost.get(lower) ?? 0) + 2);
    }
    if (isCodeIdentifier(token)) {
      boost.set(lower, (boost.get(lower) ?? 0) + 2);
    }
  }

  // Score = frequency + boost
  const scored = [...freq.entries()].map(([token, count]) => ({
    token,
    score: count + (boost.get(token) ?? 0),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxKeywords).map((s) => s.token);
}
