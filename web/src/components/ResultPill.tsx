export function ResultPill({ result }: { result: string }) {
  const normalized = result.toLowerCase();
  const className = normalized === "win" ? "pill win" : normalized === "loss" ? "pill loss" : "pill";
  return <span className={className}>{result || "unknown"}</span>;
}
