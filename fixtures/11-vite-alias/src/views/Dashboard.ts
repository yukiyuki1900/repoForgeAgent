import { Panel } from "@/components/Panel";
import { format } from "~utils/format";

export function Dashboard() {
  return `${Panel()}${format(1)}`;
}
