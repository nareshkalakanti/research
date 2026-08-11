/**
 * Alpha score for Hidden Portfolio candidates.
 */
import { ALPHA_SCORE_CAP } from "./config";

export function computeAlphaScore(input: {
  moat_keywords: string[];
  growth_keywords: string[];
  smart_money_flag: boolean;
  mcap_cr: number | null;
}): number {
  let score = 10;
  score += input.moat_keywords.length * 10;
  score += input.growth_keywords.length * 20;
  if (input.smart_money_flag) score += 50;
  if (input.mcap_cr != null && input.mcap_cr < 100) score += 15;
  return Math.min(ALPHA_SCORE_CAP, score);
}
