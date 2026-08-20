import { loadUser } from "@/user/service";

export function formatUser(user: { id: string; name: string }) {
  return `${user.name}(${user.id})`;
}

export function formatById(id: string) {
  return formatUser(loadUser(id) as never);
}
