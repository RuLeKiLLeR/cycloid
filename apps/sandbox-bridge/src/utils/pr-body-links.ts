const REVIEWER_INACCESSIBLE_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s)\]}>,`]*)?/g;
const MARKDOWN_LOCAL_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^)\s]*)?)\)/g;
const MARKDOWN_IMAGE_ABSOLUTE_LINK_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const MARKDOWN_ABSOLUTE_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const ABSOLUTE_URL_RE = /\bhttps?:\/\/[^\s)\]}>,`]+/g;

export function neutralizeReviewerInaccessibleLinks(body: string): string {
  return body
    .replace(MARKDOWN_LOCAL_LINK_RE, "$1 (`local preview URL`)")
    .replace(REVIEWER_INACCESSIBLE_URL_RE, (rawUrl, offset, input) => {
      let url = rawUrl;
      let trailing = "";
      while (/[.!?]$/.test(url)) {
        trailing = `${url.at(-1)}${trailing}`;
        url = url.slice(0, -1);
      }
      const before = input[offset - 1];
      const after = input[offset + url.length];
      if (before === "`" && after === "`") return `${url}${trailing}`;
      return `\`${url}\`${trailing}`;
    });
}

export function stripLlmAuthoredAbsoluteUrls(body: string): string {
  return body
    .replace(MARKDOWN_IMAGE_ABSOLUTE_LINK_RE, "$1")
    .replace(MARKDOWN_ABSOLUTE_LINK_RE, "$1")
    .replace(ABSOLUTE_URL_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
