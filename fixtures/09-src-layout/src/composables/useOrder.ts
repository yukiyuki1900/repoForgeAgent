import { fetchOrder } from "../services/order";

export function useOrder() {
  return fetchOrder();
}
