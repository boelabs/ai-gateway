/**
 * The shortest idle window that cannot end a session in use: `lastSeenAt` can lag real activity by
 * the session touch interval plus its cache TTL (90 s, see session.ts), so a window at or below that would time out an
 * operator who is clicking. Five minutes leaves room for an ordinary pause between requests too.
 */
export const MIN_SESSION_IDLE_MINUTES = 5;
