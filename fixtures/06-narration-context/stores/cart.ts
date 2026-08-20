import { createOrder } from "../services/order";

export { createOrder as submitOrder } from "../services/order";

export const cart = {
  count: 0,
  checkout: () => createOrder(),
};
