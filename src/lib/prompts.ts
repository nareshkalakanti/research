import fs from "fs";
import path from "path";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

/** Load editable system prompt from `prompts/<name>.system.txt`, else fallback. */
export function loadPrompt(name: string, fallback: string): string {
  const file = path.join(PROMPTS_DIR, `${name}.system.txt`);
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text.length > 20) return text;
    }
  } catch {
    /* use fallback */
  }
  return fallback.trim();
}
