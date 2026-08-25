import { createOrder } from "./order";

export function buildCart() {
  return { retry: () => createOrder() };
}
