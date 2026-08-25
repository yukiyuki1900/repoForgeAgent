import { InsightTab } from "./types";

export function fetchRank(tab: InsightTab) {
  return { tab: tab.key, items: [] as string[] };
}
