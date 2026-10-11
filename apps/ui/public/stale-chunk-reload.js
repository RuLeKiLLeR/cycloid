(() => {
  const reloadKey = "stale-chunk-reload";
  const reloadOnce = () => {
    if (sessionStorage.getItem(reloadKey)) return;
    sessionStorage.setItem(reloadKey, "1");
    window.location.reload();
  };

  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (!target || typeof target !== "object") return;

      const tagName = target.tagName?.toLowerCase();
      const assetUrl = tagName === "link" ? target.href : tagName === "script" ? target.src : null;
      if (!assetUrl) return;

      try {
        const url = new URL(assetUrl, window.location.href);
        if (url.origin === window.location.origin && url.pathname.startsWith("/assets/")) reloadOnce();
      } catch {
        // Ignore malformed URLs and leave normal browser error handling intact.
      }
    },
    true,
  );
})();
