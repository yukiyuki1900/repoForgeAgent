import { config } from "../router";

export function Home() {
  return <h1>{config.title}</h1>;
}
