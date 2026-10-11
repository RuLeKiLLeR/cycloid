export const MAX_UPLOADED_FILES = 5;
export const MAX_UPLOADED_FILE_SIZE_BYTES = 102400;
export const UPLOADED_FILE_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml", ".html"] as const;

export const MAX_UPLOADED_IMAGES = 5;
export const MAX_UPLOADED_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_PROMPT_SQL_PAYLOAD_BYTES = 1_800_000;
