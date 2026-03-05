/**
 * Pi extension that wires the epistemic monitor into the agent lifecycle:
 *
 * 1. `context` event (per-turn): evaluates the latest assistant output against
 *    the archive. If a contradiction or low-confidence signal is detected,
 *    injects a system warning into the conversation context. Also injects a
 *    session briefing on the first turn.
 *
 * 2. `session_before_compact` event: archives all messages being compacted
 *    (extracts decisions, entities, topics) so they remain searchable after
 *    the conversation summary replaces them.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { getEpistemicMonitorRuntime } from "./epistemic-monitor-runtime.js";

const log = createSubsystemLogger("epistemic-monitor");

export default function epistemicMonitorExtension(api: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // Per-turn: evaluate last assistant output + inject briefing
  // -----------------------------------------------------------------------
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getEpistemicMonitorRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const { monitor } = runtime;
    const messages = event.messages;

    // Inject session briefing on first turn (before any assistant output)
    if (!runtime.briefingInjected) {
      runtime.briefingInjected = true;
      const briefing = monitor.generateBriefing();
      if (briefing && !briefing.includes("(none)\nActive Topics: (none)")) {
        log.info("Injecting epistemic session briefing");
        const briefingMessage: AgentMessage = {
          role: "user",
          content: `<epistemic-briefing>\n${briefing}\n</epistemic-briefing>`,
          timestamp: Date.now(),
        };
        return { messages: [briefingMessage, ...messages] };
      }
    }

    // Find the last assistant message in the conversation
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    // Skip if no assistant message or already evaluated this one
    if (lastAssistantIdx < 0 || lastAssistantIdx <= runtime.lastEvaluatedTurnIndex) {
      return undefined;
    }

    runtime.lastEvaluatedTurnIndex = lastAssistantIdx;

    // Extract text content from the assistant message
    const assistantMsg = messages[lastAssistantIdx];
    const text = extractTextContent(assistantMsg);
    if (!text) {
      return undefined;
    }

    // Observe all turns since last evaluation for the monitor's context
    for (let i = Math.max(0, runtime.lastEvaluatedTurnIndex); i <= lastAssistantIdx; i++) {
      const msg = messages[i];
      const content = extractTextContent(msg);
      if (content) {
        monitor.observe(msg.role, content);
      }
    }

    // Evaluate the assistant output
    const signal = monitor.evaluate(text);
    const interrupt = monitor.checkInterrupt(signal);

    if (!interrupt) {
      return undefined;
    }

    // Inject the interrupt as a system message
    log.warn(
      `Epistemic interrupt (${interrupt.severity}): score=${signal.score.toFixed(2)}, ` +
        `flags=[${signal.flags.join(",")}]`,
    );

    const warningMessage: AgentMessage = {
      role: "user",
      content:
        `<epistemic-warning severity="${interrupt.severity}">\n` +
        `${interrupt.message}\n` +
        (interrupt.suggestedQuery
          ? `\nSuggested archive query: ${interrupt.suggestedQuery}\n`
          : "") +
        `</epistemic-warning>`,
      timestamp: Date.now(),
    };

    // Append the warning after the current messages so the agent sees it
    return { messages: [...messages, warningMessage] };
  });

  // -----------------------------------------------------------------------
  // Before compaction: archive messages that are about to be summarized
  // -----------------------------------------------------------------------
  api.on("session_before_compact", async (event, ctx) => {
    const runtime = getEpistemicMonitorRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    const { monitor } = runtime;
    const messagesToArchive = event.preparation.messagesToSummarize;

    if (messagesToArchive.length === 0) {
      return undefined;
    }

    try {
      const plainMessages = messagesToArchive
        .map((msg) => ({
          role: msg.role,
          content: extractTextContent(msg) ?? "",
        }))
        .filter((m) => m.content.length > 0);

      if (plainMessages.length === 0) {
        return undefined;
      }

      const stats = monitor.archiveMessages(plainMessages);
      log.info(
        `Epistemic archive: captured ${stats.chunksCreated} chunks before compaction ` +
          `(${stats.chunksBefore} → ${stats.chunksAfter} total)`,
      );

      // Run consolidation to mark superseded decisions
      const consolidation = monitor.consolidateDecisions();
      if (consolidation.decisionsSuperseded > 0) {
        log.info(
          `Epistemic consolidation: ${consolidation.decisionsSuperseded} superseded, ` +
            `${consolidation.decisionsActive} active`,
        );
      }
    } catch (err) {
      log.warn(
        `Epistemic archive failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Don't modify the compaction behavior — return undefined to let the
    // compaction safeguard handle summarization as normal
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextContent(message: AgentMessage): string | undefined {
  // AgentMessage is a union; access content safely via unknown cast
  const msg = message as { role: string; content?: unknown };
  if (typeof msg.content === "string") {
    return msg.content;
  }
  // For array content (AssistantMessage, UserMessage with blocks), extract text blocks
  const blocks = collectTextContentBlocks(msg.content);
  return blocks.length > 0 ? blocks.join("\n") : undefined;
}
