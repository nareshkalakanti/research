/** Node-only: checkpoint SQLite WAL on server shutdown. */
import { checkpointAllDbs } from "./lib/sqlite-utils";

let checkpointing = false;

function onShutdown(): void {
  if (checkpointing) return;
  checkpointing = true;
  try {
    checkpointAllDbs();
  } catch {
    /* best-effort — process is exiting */
  }
}

export function registerNodeShutdownHooks(): void {
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);
  process.on("beforeExit", onShutdown);
}
