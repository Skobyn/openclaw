import { homedir } from "node:os";
import { join } from "node:path";

export type ContextArchiveConfig = {
  /** Embedding provider: "auto" tries available providers in order. */
  provider: "auto" | "openai" | "gemini" | "voyage" | "mistral" | "ollama";
  /** Embedding model (provider-specific; empty = provider default). */
  model: string;
  /** SQLite database path. */
  dbPath: string;
  /** Auto-inject relevant archived context into prompts. */
  autoInject: boolean;
  /** Max chunks to inject via autoInject. */
  autoInjectTopK: number;
  /** Min similarity score for auto-inject results (0-1). */
  autoInjectMinScore: number;
  /** Max chunks returned by context_recall tool. */
  recallTopK: number;
  /** Min similarity score for recall results (0-1). */
  recallMinScore: number;
  /** Max text chars per chunk when archiving. */
  chunkMaxChars: number;
};

export const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "context-archive", "archive.sqlite");

export const DEFAULT_CONFIG: ContextArchiveConfig = {
  provider: "auto",
  model: "",
  dbPath: DEFAULT_DB_PATH,
  autoInject: true,
  autoInjectTopK: 3,
  autoInjectMinScore: 0.3,
  recallTopK: 10,
  recallMinScore: 0.2,
  chunkMaxChars: 2000,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const contextArchiveConfigSchema = {
  parse(value: unknown): ContextArchiveConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...DEFAULT_CONFIG };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "provider",
        "model",
        "dbPath",
        "autoInject",
        "autoInjectTopK",
        "autoInjectMinScore",
        "recallTopK",
        "recallMinScore",
        "chunkMaxChars",
      ],
      "context-archive config",
    );

    return {
      provider:
        typeof cfg.provider === "string" &&
        ["auto", "openai", "gemini", "voyage", "mistral", "ollama"].includes(cfg.provider)
          ? (cfg.provider as ContextArchiveConfig["provider"])
          : DEFAULT_CONFIG.provider,
      model: typeof cfg.model === "string" ? cfg.model : DEFAULT_CONFIG.model,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_CONFIG.dbPath,
      autoInject: typeof cfg.autoInject === "boolean" ? cfg.autoInject : DEFAULT_CONFIG.autoInject,
      autoInjectTopK:
        typeof cfg.autoInjectTopK === "number" ? cfg.autoInjectTopK : DEFAULT_CONFIG.autoInjectTopK,
      autoInjectMinScore:
        typeof cfg.autoInjectMinScore === "number"
          ? cfg.autoInjectMinScore
          : DEFAULT_CONFIG.autoInjectMinScore,
      recallTopK: typeof cfg.recallTopK === "number" ? cfg.recallTopK : DEFAULT_CONFIG.recallTopK,
      recallMinScore:
        typeof cfg.recallMinScore === "number" ? cfg.recallMinScore : DEFAULT_CONFIG.recallMinScore,
      chunkMaxChars:
        typeof cfg.chunkMaxChars === "number" ? cfg.chunkMaxChars : DEFAULT_CONFIG.chunkMaxChars,
    };
  },
  uiHints: {
    provider: {
      label: "Embedding Provider",
      help: 'Provider for embeddings ("auto" tries available providers)',
    },
    model: {
      label: "Embedding Model",
      help: "Model name (leave empty for provider default)",
      advanced: true,
    },
    dbPath: {
      label: "Database Path",
      placeholder: DEFAULT_DB_PATH,
      advanced: true,
    },
    autoInject: {
      label: "Auto-Inject",
      help: "Automatically inject relevant archived context into prompts",
    },
    autoInjectTopK: {
      label: "Auto-Inject Top K",
      help: "Max results to inject",
      advanced: true,
    },
    recallTopK: {
      label: "Recall Top K",
      help: "Max results from context_recall tool",
      advanced: true,
    },
  },
};
