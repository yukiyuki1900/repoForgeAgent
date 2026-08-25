import { Order } from "./order";

export interface Cart {
  items: string[];
  lastOrder?: Order;
}
