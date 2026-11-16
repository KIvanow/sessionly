import { useEffect, useRef, useState, type ReactNode } from "react";

type State = "idle" | "copied" | "failed";

/** A button that copies `text` to the clipboard and shows a short tooltip to
    confirm it. Falls back to a "could not copy" note when the clipboard is not
    available (an insecure context, or the browser refused). */
export function CopyButton({
  text,
  children,
  className,
  copiedLabel = "Copied",
}: {
  text: string;
  children: ReactNode;
  className?: string;
  /** What the tooltip says on success. */
  copiedLabel?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  const tip = state === "copied" ? copiedLabel : state === "failed" ? "Could not copy" : "";
  return (
    <span className="copy">
      <button type="button" className={className} onClick={copy}>
        {children}
      </button>
      <span
        className={`copy-tip${state === "idle" ? "" : " show"}${state === "failed" ? " failed" : ""}`}
        role="status"
        aria-live="polite"
      >
        {tip}
      </span>
    </span>
  );
}
