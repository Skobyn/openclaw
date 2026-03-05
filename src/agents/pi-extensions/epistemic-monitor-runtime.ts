import type { EpistemicArchive } from "../../memory/epistemic-archive.js";
import type { EpistemicMonitor } from "../../memory/epistemic-monitor.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type EpistemicMonitorRuntimeValue = {
  monitor: EpistemicMonitor;
  archive: EpistemicArchive;
  /** Track last evaluated assistant turn index to avoid re-evaluating. */
  lastEvaluatedTurnIndex: number;
  /** Whether a session briefing has been injected for this session. */
  briefingInjected: boolean;
};

const registry = createSessionManagerRuntimeRegistry<EpistemicMonitorRuntimeValue>();

export const setEpistemicMonitorRuntime = registry.set;

export const getEpistemicMonitorRuntime = registry.get;
