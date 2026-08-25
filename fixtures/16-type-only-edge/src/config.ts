import { createService } from "./service";

export interface AppConfig {
  name: string;
}

export const service = createService({ name: "app" });
