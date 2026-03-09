/**
 * Lightweight embedding client for context-archive.
 *
 * Two backends (Gemini, OpenAI) using only global fetch — no npm deps.
 * Uses taskType RETRIEVAL_DOCUMENT for archiving, RETRIEVAL_QUERY for search.
 */

import type { EmbeddingConfig } from "./config.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GEMINI_BATCH_MAX = 100;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) {
      return res;
    }
    // Retry on 429 and 5xx
    if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      continue;
    }
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body.slice(0, 500)}`);
  }
  throw new Error("Embedding API: max retries exceeded");
}

export class ArchiveEmbeddings {
  private provider: "gemini" | "openai";
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.provider = config.provider;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl
      ? config.baseUrl.replace(/\/+$/, "")
      : config.provider === "gemini"
        ? GEMINI_BASE_URL
        : OPENAI_BASE_URL;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!text.trim()) {
      return [];
    }
    if (this.provider === "gemini") {
      return this.geminiEmbed(text, "RETRIEVAL_QUERY");
    }
    return this.openaiEmbed([text]).then((r) => r[0] ?? []);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (this.provider === "gemini") {
      return this.geminiBatchEmbed(texts);
    }
    return this.openaiEmbed(texts);
  }

  // ---- Gemini ----

  private async geminiEmbed(text: string, taskType: string): Promise<number[]> {
    const modelPath = this.model.startsWith("models/")
      ? this.model
      : `models/${this.model}`;
    const url = `${this.baseUrl}/${modelPath}:embedContent`;

    const headers = this.geminiHeaders();
    const body = JSON.stringify({
      content: { parts: [{ text }] },
      taskType,
    });

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body,
    });

    const data = (await res.json()) as {
      embedding?: { values?: number[] };
    };
    return data.embedding?.values ?? [];
  }

  private async geminiBatchEmbed(texts: string[]): Promise<number[][]> {
    const modelPath = this.model.startsWith("models/")
      ? this.model
      : `models/${this.model}`;
    const batchUrl = `${this.baseUrl}/${modelPath}:batchEmbedContents`;
    const headers = this.geminiHeaders();

    const results: number[][] = [];

    // Process in batches of GEMINI_BATCH_MAX
    for (let i = 0; i < texts.length; i += GEMINI_BATCH_MAX) {
      const batch = texts.slice(i, i + GEMINI_BATCH_MAX);
      const requests = batch.map((text) => ({
        model: modelPath,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }));

      const res = await fetchWithRetry(batchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ requests }),
      });

      const data = (await res.json()) as {
        embeddings?: Array<{ values?: number[] }>;
      };
      const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
      for (let j = 0; j < batch.length; j++) {
        results.push(embeddings[j]?.values ?? []);
      }
    }

    return results;
  }

  private geminiHeaders(): Record<string, string> {
    // Support OAuth JSON format like gemini-auth.ts
    if (this.apiKey.startsWith("{")) {
      try {
        const parsed = JSON.parse(this.apiKey) as { token?: string };
        if (typeof parsed.token === "string" && parsed.token) {
          return {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          };
        }
      } catch {
        // fallback to API key
      }
    }
    return {
      "x-goog-api-key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  // ---- OpenAI ----

  private async openaiEmbed(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embeddings = Array.isArray(data.data) ? data.data : [];
    return texts.map((_, i) => embeddings[i]?.embedding ?? []);
  }
}
