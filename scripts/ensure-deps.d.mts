export const STAMP_FILE: string;
export function hashLockfile(contents: string): string;
export function needsInstall(lock: string | null, stamp: string | null): boolean;
export function writeStamp(): void;
