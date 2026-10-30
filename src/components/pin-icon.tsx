/** The pinned-note mark, on notes and on appointment blocks with a pinned client note. */
export function PinIcon({ className = "h-3.5 w-3.5", title = "Pinned note" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M9.83 1.17a1 1 0 0 1 1.41 0l3.59 3.59a1 1 0 0 1 0 1.41l-.7.71a1 1 0 0 1-1.06.23l-2.3 2.3.36 2.5a1 1 0 0 1-.28.85l-.7.7a1 1 0 0 1-1.42 0L6.5 11.2l-3.65 3.65a.5.5 0 0 1-.7-.7L5.79 10.5 3.54 8.24a1 1 0 0 1 0-1.41l.7-.71a1 1 0 0 1 .86-.28l2.5.36 2.3-2.3a1 1 0 0 1 .22-1.06l.71-.7Z" />
    </svg>
  );
}
