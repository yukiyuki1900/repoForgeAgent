import { Card } from "../components/Card";
import { useOrder } from "../composables/useOrder";

export function Home() {
  return `${Card()}${useOrder()}`;
}
