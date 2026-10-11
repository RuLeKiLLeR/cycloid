// Hard safety floor: automated cleanup may stop/pause younger sessions, but it must never archive them.
export const SESSION_AUTO_ARCHIVE_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1_000;
