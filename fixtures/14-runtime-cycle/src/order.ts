import { buildCart } from "./cart";

export function createOrder() {
  return { cart: buildCart() };
}
