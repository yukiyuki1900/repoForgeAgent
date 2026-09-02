import { parseFlag } from "./helper";

if (!parseFlag("1")) throw new Error("parseFlag should accept 1");
