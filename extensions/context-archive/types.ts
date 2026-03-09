/**
 * Shared types for the context-archive plugin.
 * Re-exported from the plugin types to avoid deep imports.
 */

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
