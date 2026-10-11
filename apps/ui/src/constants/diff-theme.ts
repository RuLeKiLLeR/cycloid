/**
 * Theme and default props for react-diff-viewer-continued.
 * Colors map our design tokens (from App.css @theme) to the library's style variables.
 * The app is dark-only, so only the Radix Sand dark palette is defined and every
 * ReactDiffViewer renders with `useDarkTheme`.
 */

/** Shared props applied to every ReactDiffViewer instance (theme decided per-render). */
const diffViewerDefaults = {
  splitView: false,
  showDiffOnly: true,
  extraLinesSurroundingDiff: 3,
} as const;

const diffViewerStyles = {
  variables: {
    dark: {
      diffViewerBackground: "#191918", // surface-1 dark
      diffViewerColor: "#ededec", // text-primary dark
      addedBackground: "#4cc38a1f", // success dark at ~12%
      addedColor: "#ededec",
      removedBackground: "#ff63691f", // error dark at ~12%
      removedColor: "#ededec",
      wordAddedBackground: "#4cc38a40", // success dark at 25%
      wordRemovedBackground: "#ff636940", // error dark at 25%
      addedGutterBackground: "#4cc38a2e", // success dark at ~18%
      removedGutterBackground: "#ff63692e", // error dark at ~18%
      gutterBackground: "#111110", // surface-0 dark
      gutterBackgroundDark: "#222221", // surface-2 dark
      gutterColor: "#8d8d86", // text-muted dark
      addedGutterColor: "#8d8d86",
      removedGutterColor: "#8d8d86",
      codeFoldGutterBackground: "#222221", // surface-2 dark
      codeFoldBackground: "#222221",
      codeFoldContentColor: "#8d8d86", // text-muted dark
      emptyLineBackground: "#111110",
      diffViewerTitleBackground: "#222221", // surface-2 dark
      diffViewerTitleColor: "#b5b3ad", // text-secondary dark
      diffViewerTitleBorderColor: "#3b3a37", // border dark
    },
  },
  diffContainer: {
    minWidth: "unset",
    fontSize: "11px",
    "& pre": {
      lineHeight: "1.45",
    },
  },
  gutter: {
    fontSize: "11px",
    minWidth: "35px",
    width: "35px",
    padding: "0 6px",
    "& pre": {
      opacity: "0.5",
    },
  },
  contentText: {
    fontFamily: "var(--font-mono)",
    fontFeatureSettings: '"tnum", "zero"',
  },
  line: {
    fontSize: "11px",
  },
  codeFold: {
    fontSize: "11px",
  },
};

/** Combined defaults + styles, ready to spread onto ReactDiffViewer. */
export const diffViewerProps = {
  ...diffViewerDefaults,
  styles: diffViewerStyles,
} as const;
