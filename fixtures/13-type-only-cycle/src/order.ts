import { Cart } from "./cart";

export interface Order {
  id: string;
  cart: Cart;
}

export function createOrder(cart: Cart): Order {
  return { id: "1", cart };
}
