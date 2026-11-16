/** A loading indicator in the ledger's look: an indeterminate blue strip over a
    track, with a small-caps label. Shown while a request is in flight and there
    is nothing yet to put in its place. */
export function Loader({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={className ? `loader ${className}` : "loader"} role="status">
      <span className="loader-bar" aria-hidden="true">
        <i />
      </span>
      <span className="loader-label">{label}…</span>
    </div>
  );
}
