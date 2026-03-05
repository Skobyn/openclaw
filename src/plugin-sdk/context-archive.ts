// Narrow plugin-sdk surface for the bundled context-archive plugin.
// Keep this list additive and scoped to symbols used under extensions/context-archive.

export type { OpenClawPluginApi } from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { EmbeddingProvider } from "../memory/embeddings.js";
export { createEmbeddingProvider } from "../memory/embeddings.js";
export type { EmbeddingProviderOptions, EmbeddingProviderRequest } from "../memory/embeddings.js";
export { extractDecisions, extractEntities, extractTopics } from "../memory/decision-extractor.js";
