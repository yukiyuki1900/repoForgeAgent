import { fetchRank } from "./apis";

export type RankQuery = Awaited<ReturnType<typeof fetchRank>>;

export interface InsightTab {
  key: string;
  label: string;
}
