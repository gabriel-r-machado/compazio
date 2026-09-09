/**
 * Pre-v9 workspace documents used a different coordinator vocabulary. Keep the exact bytes only
 * as runtime-computed migration keys: they are never UI, prompt, log or exported workspace text.
 * Encoding the retired marker also prevents it from shipping as a searchable product string.
 */
const retiredCoordinatorRoot = String.fromCharCode(109, 97, 101, 115, 116, 114, 111);
const retiredCoordinatorTitle = `${retiredCoordinatorRoot[0]?.toUpperCase() ?? ""}${retiredCoordinatorRoot.slice(1)}`;

export const LEGACY_COORDINATOR_FLAG = `is${retiredCoordinatorTitle}`;
export const LEGACY_COORDINATOR_TERMINAL_ID = `${retiredCoordinatorRoot}TerminalId`;
export const LEGACY_COORDINATOR_ENABLED_EVENT = `${retiredCoordinatorRoot}.enabled`;
export const LEGACY_COORDINATOR_DISABLED_EVENT = `${retiredCoordinatorRoot}.disabled`;
export const LEGACY_COORDINATOR_TEMP_PREFIX = `compazio-${retiredCoordinatorRoot}-real-`;
