import { cart } from "../stores/cart";
import { formatTitle } from "../utils/format";

export function createOrder() {
  return { id: formatTitle(String(cart.count)) };
}
