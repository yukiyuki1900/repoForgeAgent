import { Card } from "../components/Card";
import { createOrder } from "../services/order";

export function Home() {
  return <Card title={createOrder().id} />;
}
