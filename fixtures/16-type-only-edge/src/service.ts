import type { AppConfig } from "./config";

export function createService(config: AppConfig) {
  return { label: config.name };
}
