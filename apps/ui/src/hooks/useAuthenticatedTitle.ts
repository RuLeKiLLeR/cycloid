import { useRef } from "react";

import { clearAuthenticatedBaseTitle, setAuthenticatedBaseTitle } from "../utils/authenticated-title";
import { useSyncEffect } from "./useEffects";

export function useAuthenticatedTitle(title: string) {
  const ownerRef = useRef(Symbol("authenticated-title-owner"));

  useSyncEffect(() => {
    const owner = ownerRef.current;
    setAuthenticatedBaseTitle(owner, title);
    return () => clearAuthenticatedBaseTitle(owner);
  }, [title]);
}
