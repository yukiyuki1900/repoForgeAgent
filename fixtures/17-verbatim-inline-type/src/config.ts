import { type AppService } from "./service";

export const DEFAULT_NAME = "app";

export function describe(service: AppService): string {
  return service.name;
}
