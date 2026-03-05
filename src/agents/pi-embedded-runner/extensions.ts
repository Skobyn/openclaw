import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { EpistemicArchive } from "../../memory/epistemic-archive.js";
import { EpistemicMonitor } from "../../memory/epistemic-monitor.js";
import { resolveUserPath } from "../../utils.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import epistemicMonitorExtension from "../pi-extensions/epistemic-monitor-extension.js";
import { setEpistemicMonitorRuntime } from "../pi-extensions/epistemic-monitor-runtime.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

function resolveEpistemicArchivePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "epistemic", `${agentId}.sqlite`);
  if (!raw) {
    return fallback;
  }
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}

function buildEpistemicMonitorFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
}): ExtensionFactory | undefined {
  const epistemicCfg = params.cfg?.agents?.defaults?.epistemic;
  if (!epistemicCfg?.enabled) {
    return undefined;
  }

  // Use a stable agent identifier; fallback to "default" for single-agent setups
  const agentId = "default";
  const archivePath = resolveEpistemicArchivePath(agentId, epistemicCfg.archivePath);

  const archive = new EpistemicArchive(archivePath);
  const sessionId = `session-${Date.now()}`;
  const monitor = new EpistemicMonitor({
    archive,
    sessionId,
    config: {
      hardInterruptThreshold: epistemicCfg.hardInterruptThreshold,
      softNudgeThreshold: epistemicCfg.softNudgeThreshold,
      maxObservedTurns: epistemicCfg.maxObservedTurns,
    },
  });

  setEpistemicMonitorRuntime(params.sessionManager, {
    monitor,
    archive,
    lastEvaluatedTurnIndex: -1,
    briefingInjected: false,
  });

  return epistemicMonitorExtension;
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      identifierInstructions: compactionCfg?.identifierInstructions,
      model: params.model,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  const epistemicFactory = buildEpistemicMonitorFactory(params);
  if (epistemicFactory) {
    factories.push(epistemicFactory);
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
