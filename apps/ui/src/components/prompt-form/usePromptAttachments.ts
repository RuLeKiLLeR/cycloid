import type React from "react";
import { useCallback, useRef, useState } from "react";

import type { UploadedFile, UploadedImage } from "../../../../../shared/types/sandbox";
import { stringifyError } from "../../../../../shared/utils/errors.js";
import {
  validatePromptUploadSqlPayload,
  validateUploadedFilePayload,
  validateUploadedFileSelection,
  validateUploadedImagePayload,
  validateUploadedImageSelection,
} from "../../../../../shared/utils/uploads";
import { useSyncEffect } from "../../hooks/useEffects";
import {
  partitionFilesByKind,
  prepareImageSelectionCandidates,
  readFileAsBase64,
  readFileWith,
} from "../../utils/prompt-form";

export function usePromptAttachments({ promptText }: { promptText: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const uploadedFilesRef = useRef<UploadedFile[]>([]);
  const uploadedImagesRef = useRef<UploadedImage[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [promptPayloadError, setPromptPayloadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const processFiles = useCallback(
    async (fileList: FileList | File[], opts: { clearErrors: boolean } = { clearErrors: true }) => {
      if (opts.clearErrors) setUploadError(null);
      const files = Array.from(fileList);
      const existingNames = uploadedFilesRef.current.map((file) => file.name);

      const selection = validateUploadedFileSelection(files, existingNames);
      if (!selection.ok) {
        setUploadError(selection.error);
        return false;
      }

      const newFiles: UploadedFile[] = [];
      for (const file of selection.value) {
        try {
          const content = await readFileWith(file, "readAsText");
          newFiles.push({ name: file.name, content });
        } catch (err) {
          setUploadError(`Failed to read ${file.name}: ${stringifyError(err)}`);
          return false;
        }
      }

      const latestFileNames = uploadedFilesRef.current.map((file) => file.name);
      const payloadValidation = validateUploadedFilePayload(newFiles, latestFileNames);
      if (!payloadValidation.ok) {
        setUploadError(payloadValidation.error);
        return false;
      }

      if (payloadValidation.value.length > 0) {
        const nextUploadedFiles = [...uploadedFilesRef.current, ...payloadValidation.value];
        const promptPayloadValidation = validatePromptUploadSqlPayload({
          promptText,
          uploadedFiles: nextUploadedFiles,
          uploadedImages: uploadedImagesRef.current,
        });
        if (!promptPayloadValidation.ok) {
          setPromptPayloadError(promptPayloadValidation.error);
          return false;
        }
        setPromptPayloadError(null);
        uploadedFilesRef.current = nextUploadedFiles;
        setUploadedFiles(nextUploadedFiles);
      }
      return true;
    },
    [promptText],
  );

  const removeUploadedFile = useCallback((name: string) => {
    const next = uploadedFilesRef.current.filter((file) => file.name !== name);
    uploadedFilesRef.current = next;
    setUploadedFiles(next);
    setUploadError(null);
  }, []);

  const processImageFiles = useCallback(
    async (imageFiles: File[], opts: { clearErrors: boolean } = { clearErrors: true }) => {
      if (opts.clearErrors) setUploadError(null);
      const existingNames = uploadedImagesRef.current.map((image) => image.name);
      const timestamp = Date.now();
      const candidates = prepareImageSelectionCandidates(imageFiles, timestamp);
      const selection = validateUploadedImageSelection(candidates, existingNames, "images");
      if (!selection.ok) {
        setUploadError(selection.error);
        return false;
      }
      if (selection.value.length === 0) return true;

      try {
        const newImages = await Promise.all(
          selection.value.map(async (candidate) => {
            const data = await readFileAsBase64(candidate.file);
            return { name: candidate.name, mediaType: candidate.type, data };
          }),
        );

        const latestImageNames = uploadedImagesRef.current.map((image) => image.name);
        const payloadValidation = validateUploadedImagePayload(newImages, latestImageNames);
        if (!payloadValidation.ok) {
          setUploadError(payloadValidation.error);
          return false;
        }

        const nextUploadedImages = [...uploadedImagesRef.current, ...payloadValidation.value];
        const promptPayloadValidation = validatePromptUploadSqlPayload({
          promptText,
          uploadedFiles: uploadedFilesRef.current,
          uploadedImages: nextUploadedImages,
        });
        if (!promptPayloadValidation.ok) {
          setPromptPayloadError(promptPayloadValidation.error);
          return false;
        }
        setPromptPayloadError(null);

        uploadedImagesRef.current = nextUploadedImages;
        setUploadedImages(nextUploadedImages);
        return true;
      } catch (err) {
        setUploadError(`Failed to read image: ${stringifyError(err)}`);
        return false;
      }
    },
    [promptText],
  );

  const processSelection = useCallback(
    async (fileList: FileList | File[]) => {
      setUploadError(null);
      const { images, nonImages } = partitionFilesByKind(Array.from(fileList));
      if (images.length > 0) {
        const imagesOk = await processImageFiles(images, { clearErrors: false });
        // Image validation failures invalidate the whole mixed selection so users can retry one consistent batch.
        if (!imagesOk) return false;
      }
      if (nonImages.length > 0) {
        return processFiles(nonImages, { clearErrors: false });
      }
      return true;
    },
    [processFiles, processImageFiles],
  );

  useSyncEffect(() => {
    if (uploadedFiles.length === 0 && uploadedImages.length === 0) {
      setPromptPayloadError(null);
      return;
    }

    const validation = validatePromptUploadSqlPayload({
      promptText,
      uploadedFiles,
      uploadedImages,
    });
    setPromptPayloadError(validation.ok ? null : validation.error);
  }, [promptText, uploadedFiles, uploadedImages]);

  const removeUploadedImage = useCallback((name: string) => {
    const next = uploadedImagesRef.current.filter((image) => image.name !== name);
    uploadedImagesRef.current = next;
    setUploadedImages(next);
    setUploadError(null);
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);
      const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      event.preventDefault();
      const imageFiles = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
      if (imageFiles.length > 0) {
        void processImageFiles(imageFiles);
      }
    },
    [processImageFiles],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragOver(false);
      if (event.dataTransfer.files.length > 0) {
        void processSelection(event.dataTransfer.files);
      }
    },
    [processSelection],
  );

  const resetAttachmentsAfterSubmit = useCallback(() => {
    uploadedFilesRef.current = [];
    uploadedImagesRef.current = [];
    setUploadedFiles([]);
    setUploadedImages([]);
    setUploadError(null);
    setPromptPayloadError(null);
  }, []);

  return {
    fileInputRef,
    uploadedFiles,
    uploadedImages,
    uploadError: uploadError ?? promptPayloadError,
    isDragOver,
    processFiles,
    processSelection,
    removeUploadedFile,
    processImageFiles,
    removeUploadedImage,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    resetAttachmentsAfterSubmit,
  };
}
