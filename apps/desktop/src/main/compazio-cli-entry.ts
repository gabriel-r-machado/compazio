/**
 * The entrypoint an agent's terminal reaches through the `compazio` shim.
 *
 * It exists so the CLI ships as one bundled file inside the packaged app: the shim runs the app's own
 * Electron binary with `ELECTRON_RUN_AS_NODE=1`, which keeps the native `better-sqlite3` binding on
 * the ABI it was built for. Importing the module runs it — the CLI is a script, not a library — and
 * everything it needs (workspace discovery, stores, command surface) comes from the same workspace
 * packages the main process already bundles.
 */
import "@forgedeck/cli/bin";
