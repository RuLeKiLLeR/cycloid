import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { UPLOADED_FILE_EXTENSIONS } from "../../../shared/constants/uploads.js";
import { stringifyError } from "../../../shared/utils/errors.js";
import { validateUploadedFilePayload } from "../../../shared/utils/uploads.js";
import { CliError } from "./errors.js";

export type UploadedFileOption = string | string[] | undefined;

type CliUploadedFile = {
  name: string;
  content: string;
};

export async function resolveUploadedFileOptions(files: UploadedFileOption): Promise<CliUploadedFile[] | undefined> {
  const paths = normalizeUploadedFileOptions(files);
  if (paths.length === 0) return undefined;
  const names = paths.map((path) => basename(path));
  validateUploadedFileNames(names);

  const uploadedFiles = await Promise.all(
    paths.map(async (path) => {
      const name = basename(path);
      try {
        return { name, content: await readFile(path, "utf8") };
      } catch (err) {
        const message = stringifyError(err);
        throw new CliError("user", `Failed to read uploaded file ${path}: ${message}`);
      }
    }),
  );

  const validation = validateUploadedFilePayload(uploadedFiles);
  if (!validation.ok) {
    throw new CliError("user", validation.error);
  }

  return validation.value;
}

export function collectUploadedFileOption(path: string, previous: string[] = []): string[] {
  return [...previous, path];
}

function validateUploadedFileNames(names: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new CliError(
      "user",
      `Duplicate uploaded-file basenames: ${[...duplicates].join(", ")}. Rename or move them so each basename is unique.`,
    );
  }

  for (const name of names) {
    const ext = extname(name).toLowerCase();
    if (!(UPLOADED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new CliError("user", `Unsupported file type: ${name}. Supported: ${UPLOADED_FILE_EXTENSIONS.join(", ")}`);
    }
  }
}

function normalizeUploadedFileOptions(files: UploadedFileOption): string[] {
  if (!files) return [];
  return Array.isArray(files) ? files : [files];
}
