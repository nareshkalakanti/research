export function napkinLog(event: string, extra?: Record<string, unknown>) {
  console.info(`[napkin] ${event}`, extra ?? "");
}
