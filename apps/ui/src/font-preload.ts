import geistLatinNormalWoff2Url from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";

const existingPreload = document.head.querySelector<HTMLLinkElement>(
  `link[rel="preload"][as="font"][href="${geistLatinNormalWoff2Url}"]`,
);

if (!existingPreload) {
  const preload = document.createElement("link");
  preload.rel = "preload";
  preload.as = "font";
  preload.type = "font/woff2";
  preload.crossOrigin = "anonymous";
  preload.href = geistLatinNormalWoff2Url;
  document.head.append(preload);
}
