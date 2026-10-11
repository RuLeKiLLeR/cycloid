import type { MutableRefObject } from "react";

export function beginLatestRequest(sequenceRef: MutableRefObject<number>): number {
  return ++sequenceRef.current;
}

export function isLatestRequest(sequenceRef: MutableRefObject<number>, sequence: number): boolean {
  return sequence === sequenceRef.current;
}
