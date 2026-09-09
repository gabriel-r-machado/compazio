/**
 * The product brand and coordinating-role label shown to a person or injected into an agent prompt.
 *
 * Internal vocabulary for the coordinating role is `compazio` (`isCompazio`, `compazioTerminalId`,
 * `compazio.enabled`). Older documents are translated on read through a private compatibility shim.
 * Some identifiers stay legacy on purpose — package names and `compazio-v2:*` IPC channels — because
 * renaming them would break live sessions for no user benefit. None of that vocabulary may reach the
 * interface.
 */
export const PRODUCT_NAME = "COMPAZIO" as const;

/**
 * There is no separate public coordinator brand. The product name is the only name shown to
 * people or injected into agents; legacy `compasso` identifiers remain internal compatibility.
 */
export const ORCHESTRATOR_LABEL = PRODUCT_NAME;
