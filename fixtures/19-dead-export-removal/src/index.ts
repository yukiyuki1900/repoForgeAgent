import { readConfig } from "./config";
import { activeFlag } from "./effects";
import { render } from "./format";
import { activeHelper } from "./utils";

export function main(): string {
  return render(`${activeHelper()} ${readConfig()} ${activeFlag}`);
}
