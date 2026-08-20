import { formatTitle } from "../utils/format";

export const Card = ({ title }: { title: string }) => <div>{formatTitle(title)}</div>;
