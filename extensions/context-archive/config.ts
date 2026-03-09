import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";

export type EmbeddingProvider = "gemini" | "openai";

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  dimensions?: number;
};

export type ContextArchiveConfig = {
  embedding: EmbeddingConfig;
  dbPath: string;
  autoInject: boolean;
  maxInjectChunks: number;
  chunkTokens: number;
  consolidateAfter: number;
};

const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "gemini-embedding-001": 768,
  "text-embedding-004": 768,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "context-archive", "archive.db");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }
  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(provider: EmbeddingProvider, model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (dims) {
    return dims;
  }
  // Sensible defaults for unknown models
  return provider === "gemini" ? 768 : 1536;
}

export const contextArchiveConfigSchema = {
  parse(value: unknown): ContextArchiveConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("context-archive config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoInject", "maxInjectChunks", "chunkTokens", "consolidateAfter"],
      "context-archive config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(
      embedding,
      ["provider", "apiKey", "model", "baseUrl", "dimensions"],
      "embedding config",
    );

    const provider: EmbeddingProvider =
      embedding.provider === "openai" ? "openai" : "gemini";

    const defaultModel = provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENAI_MODEL;
    const model = typeof embedding.model === "string" ? embedding.model : defaultModel;

    const maxInjectChunks =
      typeof cfg.maxInjectChunks === "number" ? Math.floor(cfg.maxInjectChunks) : 3;
    if (maxInjectChunks < 1 || maxInjectChunks > 20) {
      throw new Error("maxInjectChunks must be between 1 and 20");
    }

    const chunkTokens =
      typeof cfg.chunkTokens === "number" ? Math.floor(cfg.chunkTokens) : 512;
    if (chunkTokens < 128 || chunkTokens > 4096) {
      throw new Error("chunkTokens must be between 128 and 4096");
    }

    const consolidateAfter =
      typeof cfg.consolidateAfter === "number" ? Math.floor(cfg.consolidateAfter) : 50;
    if (consolidateAfter < 10 || consolidateAfter > 500) {
      throw new Error("consolidateAfter must be between 10 and 500");
    }

    return {
      embedding: {
        provider,
        apiKey: resolveEnvVars(embedding.apiKey),
        model,
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions:
          typeof embedding.dimensions === "number" ? embedding.dimensions : undefined,
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoInject: cfg.autoInject !== false,
      maxInjectChunks,
      chunkTokens,
      consolidateAfter,
    };
  },
};
