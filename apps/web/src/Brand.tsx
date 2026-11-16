/** The mark and the name, as on the website: three lines of a ledger, the last one in blue. */
export function Brand() {
  return (
    <a className="brand" href="#/">
      <svg viewBox="0 0 30 30" aria-hidden="true">
        <rect width="30" height="30" rx="4" fill="#f6f5f0" />
        <path d="M7 8h16v3H7zM7 13.5h11v3H7z" fill="#14161a" />
        <path d="M7 19h14v3H7z" fill="#1c5cab" />
      </svg>
      Sessionly
    </a>
  );
}
