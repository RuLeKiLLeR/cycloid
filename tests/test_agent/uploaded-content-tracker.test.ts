import { describe, expect, it } from "vitest";

import { UploadedContentTracker } from "../../apps/sandbox-bridge/src/utils/uploaded-files.js";

describe("UploadedContentTracker", () => {
  describe("findNewFiles", () => {
    it("returns all files before anything is committed", () => {
      const tracker = new UploadedContentTracker();
      const files = [
        { name: "a.txt", content: "aaa" },
        { name: "b.txt", content: "bbb" },
      ];

      expect(tracker.findNewFiles(files)).toEqual(files);
      expect(tracker.findNewFiles(files)).toEqual(files);
    });

    it("filters out files only after commitSeen", () => {
      const tracker = new UploadedContentTracker();
      const files = [
        { name: "a.txt", content: "aaa" },
        { name: "b.txt", content: "bbb" },
      ];

      const novel = tracker.findNewFiles(files);
      tracker.commitSeen({ files: novel });

      expect(tracker.findNewFiles(files)).toEqual([]);
    });

    it("returns only new files after earlier files are committed", () => {
      const tracker = new UploadedContentTracker();
      tracker.commitSeen({ files: tracker.findNewFiles([{ name: "a.txt", content: "aaa" }]) });

      expect(
        tracker.findNewFiles([
          { name: "a.txt", content: "aaa" },
          { name: "b.txt", content: "bbb" },
        ]),
      ).toEqual([{ name: "b.txt", content: "bbb" }]);
    });

    it("deduplicates duplicate names within a single batch", () => {
      const tracker = new UploadedContentTracker();

      expect(
        tracker.findNewFiles([
          { name: "a.txt", content: "one" },
          { name: "a.txt", content: "two" },
          { name: "b.txt", content: "three" },
        ]),
      ).toEqual([
        { name: "a.txt", content: "one" },
        { name: "b.txt", content: "three" },
      ]);
    });

    it("returns empty array for undefined or empty input", () => {
      const tracker = new UploadedContentTracker();
      expect(tracker.findNewFiles(undefined)).toEqual([]);
      expect(tracker.findNewFiles([])).toEqual([]);
    });
  });

  describe("findNewImages", () => {
    const img = (n: number) => ({
      name: `img${n}.png`,
      mediaType: "image/png",
      data: `base64data${n}`,
    });

    it("returns all images before commitSeen", () => {
      const tracker = new UploadedContentTracker();
      const images = [img(1), img(2)];

      expect(tracker.findNewImages(images)).toEqual(images);
      expect(tracker.findNewImages(images)).toEqual(images);
    });

    it("filters out images only after commitSeen", () => {
      const tracker = new UploadedContentTracker();
      const images = [img(1), img(2)];

      const novel = tracker.findNewImages(images);
      tracker.commitSeen({ images: novel });

      expect(tracker.findNewImages(images)).toEqual([]);
    });

    it("returns only uncommitted images when the array grows", () => {
      const tracker = new UploadedContentTracker();
      tracker.commitSeen({ images: tracker.findNewImages([img(1), img(2)]) });

      expect(tracker.findNewImages([img(1), img(2), img(3)])).toEqual([img(3)]);
    });

    it("deduplicates by name regardless of data changes after commit", () => {
      const tracker = new UploadedContentTracker();
      tracker.commitSeen({ images: tracker.findNewImages([{ name: "img.png", mediaType: "image/png", data: "v1" }]) });

      expect(tracker.findNewImages([{ name: "img.png", mediaType: "image/png", data: "v2" }])).toEqual([]);
    });
  });

  describe("independent tracking", () => {
    it("tracks files and images separately", () => {
      const tracker = new UploadedContentTracker();
      tracker.commitSeen({
        files: tracker.findNewFiles([{ name: "a.txt", content: "a" }]),
        images: tracker.findNewImages([{ name: "img1.png", mediaType: "image/png", data: "d1" }]),
      });

      expect(tracker.findNewFiles([{ name: "a.txt", content: "a" }])).toEqual([]);
      expect(tracker.findNewFiles([{ name: "b.txt", content: "b" }])).toEqual([{ name: "b.txt", content: "b" }]);

      expect(tracker.findNewImages([{ name: "img1.png", mediaType: "image/png", data: "d1" }])).toEqual([]);
      expect(
        tracker.findNewImages([
          { name: "img1.png", mediaType: "image/png", data: "d1" },
          { name: "img2.png", mediaType: "image/png", data: "d2" },
        ]),
      ).toEqual([{ name: "img2.png", mediaType: "image/png", data: "d2" }]);
    });

    it("reset clears committed file and image state", () => {
      const tracker = new UploadedContentTracker();
      const files = [
        { name: "a.txt", content: "a" },
        { name: "b.txt", content: "b" },
      ];
      const images = [
        { name: "img1.png", mediaType: "image/png", data: "d1" },
        { name: "img2.png", mediaType: "image/png", data: "d2" },
      ];
      tracker.commitSeen({
        files: tracker.findNewFiles(files),
        images: tracker.findNewImages(images),
      });

      expect(tracker.findNewFiles(files)).toEqual([]);
      expect(tracker.findNewImages(images)).toEqual([]);

      tracker.reset();

      expect(tracker.findNewFiles(files)).toEqual(files);
      expect(tracker.findNewImages(images)).toEqual(images);
    });

    it("reset clears file and image state independently", () => {
      const tracker = new UploadedContentTracker();
      const file = { name: "a.txt", content: "a" };
      const image = { name: "img1.png", mediaType: "image/png", data: "d1" };
      tracker.commitSeen({ files: tracker.findNewFiles([file]) });

      tracker.reset();
      tracker.commitSeen({ images: tracker.findNewImages([image]) });

      expect(tracker.findNewFiles([file])).toEqual([file]);
      expect(tracker.findNewImages([image])).toEqual([]);
    });
  });
});
