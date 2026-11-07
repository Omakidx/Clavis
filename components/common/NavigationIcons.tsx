/** The supplied slim chevron, rotated for page navigation where needed. */
export function ChevronIcon({ direction = 'down' }: { direction?: 'down' | 'left' | 'right' }) {
  const rotate = direction === 'left' ? '90deg' : direction === 'right' ? '-90deg' : undefined;
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={rotate ? { rotate } : undefined}
    >
      <path
        d="M19.9201 8.9502L13.4001 15.4702C12.6301 16.2402 11.3701 16.2402 10.6001 15.4702L4.08008 8.9502"
        stroke="currentColor"
        strokeWidth="0.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Simple 1.5px strokes for reader zoom controls. */
export function ZoomIcon({ direction }: { direction: 'in' | 'out' }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {direction === 'in' ? (
        <path d="M12 5v14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}
