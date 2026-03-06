import type { ReactNode } from "react";

type StatusTone = "neutral" | "error";

type StatusMessageProps = {
  children: ReactNode;
  tone?: StatusTone;
};

export function StatusMessage({ children, tone = "neutral" }: StatusMessageProps) {
  const isError = tone === "error";

  return (
    <p className={`state${isError ? " error" : ""}`} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} aria-atomic="true">
      {children}
    </p>
  );
}
