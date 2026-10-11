import { useRef, useState } from "react";

import { useLayoutSyncEffect } from "./useEffects";

export function useTransitionReveal<T>(value: T, revealValue: T): boolean {
  const previousRef = useRef(value);
  const revealedRef = useRef(false);
  const [revealed, setRevealed] = useState(false);

  useLayoutSyncEffect(() => {
    if (!revealedRef.current && previousRef.current !== revealValue && value === revealValue) {
      revealedRef.current = true;
      setRevealed(true);
    }
    previousRef.current = value;
  }, [value, revealValue]);

  return revealed;
}
