import { useCallback, useRef, useState } from "react";

export function useCopyToClipboard(resetMs = 2000): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const copy = useCallback(
    (text: string) => {
      // Await the write and only flip to "copied" on success; a failed or
      // unavailable clipboard (permissions, insecure context, no API) must not
      // show a false confirmation. A missing `navigator.clipboard` rejects
      // rather than resolving undefined, which would take the success path.
      void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("clipboard unavailable")))
        .then(() => {
          setCopied(true);
          clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
        })
        .catch(() => {
          setCopied(false);
        });
    },
    [resetMs],
  );

  return [copied, copy];
}
