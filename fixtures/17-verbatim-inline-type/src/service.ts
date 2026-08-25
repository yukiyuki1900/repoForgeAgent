import { DEFAULT_NAME } from "./config";

export interface AppService {
  name: string;
}

export function createService(): AppService {
  return { name: DEFAULT_NAME };
}
