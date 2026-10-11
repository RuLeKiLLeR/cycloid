export const NO_RECORD_MESSAGE: string;
export const NULL_ID_MESSAGE: string;

export type VersionUploadExtraction = {
  sawRecord: boolean;
  id: string | null;
};

export function extractVersionId(ndjson: string): VersionUploadExtraction;
