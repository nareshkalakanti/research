/** Checkpoint SQLite WAL on server shutdown so .db files stay self-contained. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNodeShutdownHooks } = await import("./instrumentation-node");
  registerNodeShutdownHooks();
}
