import { formatUser } from "@/shared/format";

export function loadUser(id: string) {
  return formatUser({ id, name: "demo" });
}
