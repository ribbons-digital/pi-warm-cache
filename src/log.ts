import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type WarmLogEvent = {
  ts: string;
  sessionId?: string;
  event: string;
  detail?: string;
  ok?: boolean;
  reason?: string;
  [key: string]: unknown;
};

/**
 * Append one JSONL diagnostic line.
 * Never write to stdout/stderr from timer paths - that can corrupt pi-tui frames.
 */
export function appendWarmLog(cwd: string | null | undefined, event: WarmLogEvent): string | null {
  try {
    const root = cwd && cwd.length > 0 ? cwd : process.cwd();
    const filePath = join(root, ".pi", "warm-cache.jsonl");
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return filePath;
  } catch {
    return null;
  }
}

export function warmLogPath(cwd: string | null | undefined): string {
  const root = cwd && cwd.length > 0 ? cwd : process.cwd();
  return join(root, ".pi", "warm-cache.jsonl");
}
