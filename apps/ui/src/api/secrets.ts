import { z } from "zod";

import { apiCacheKeys, invalidate, swr } from "./cache";
import { JSON_HEADERS, requestJsonValidated } from "./client";

export type SecretEntryMeta = {
  key: string;
  usageNote: string | null;
  sensitive: boolean;
};

export type RepositoryEnvironmentConfig = {
  id: string;
  repoOwner: string;
  repoName: string;
  keyNames: string[];
  entries?: SecretEntryMeta[];
  createdAt: number;
  updatedAt: number;
};

export type PersonalSecretsConfig = {
  id: string;
  keyNames: string[];
  entries: SecretEntryMeta[];
  createdAt: number;
  updatedAt: number;
};

const secretEntryMetaSchema = z.object({
  key: z.string(),
  usageNote: z.string().nullable(),
  sensitive: z.boolean(),
});

const repositoryEnvironmentConfigSchema = z.object({
  id: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  keyNames: z.array(z.string()),
  entries: z.array(secretEntryMetaSchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const personalSecretsConfigSchema = z.object({
  id: z.string(),
  keyNames: z.array(z.string()),
  entries: z.array(secretEntryMetaSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const repositoryEnvironmentConfigResponseSchema = z.object({
  loginEnv: repositoryEnvironmentConfigSchema.nullable(),
});

const upsertRepositoryEnvironmentVariableResponseSchema = z.object({
  loginEnv: repositoryEnvironmentConfigSchema,
});

const importRepositoryEnvironmentVariablesResponseSchema = z.object({
  loginEnv: repositoryEnvironmentConfigSchema,
  importedCount: z.number(),
});

const deleteRepositoryEnvironmentVariableResponseSchema = z.object({
  loginEnv: repositoryEnvironmentConfigSchema.nullable(),
  changed: z.boolean(),
});

const personalSecretsResponseSchema = z.object({
  secrets: personalSecretsConfigSchema.nullable(),
});

const upsertPersonalSecretResponseSchema = z.object({
  secrets: personalSecretsConfigSchema,
});

const importPersonalSecretsResponseSchema = z.object({
  secrets: personalSecretsConfigSchema,
  importedCount: z.number(),
});

const deletePersonalSecretResponseSchema = z.object({
  secrets: personalSecretsConfigSchema.nullable(),
  changed: z.boolean(),
});

export async function fetchRepositoryEnvironmentConfig(
  businessId: string,
  repoOwner: string,
  repoName: string,
): Promise<RepositoryEnvironmentConfig | null> {
  const result = await swr(
    apiCacheKeys.repoEnvironment(businessId, repoOwner, repoName),
    () =>
      requestJsonValidated(
        `/api/businesses/${businessId}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/environment-variables`,
        undefined,
        "Failed to fetch repository environment variables",
        { schema: repositoryEnvironmentConfigResponseSchema },
      ).then((data) => data.loginEnv),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function upsertRepositoryEnvironmentVariable(
  businessId: string,
  repoOwner: string,
  repoName: string,
  key: string,
  value: string,
  options?: { usageNote?: string | null; sensitive?: boolean },
): Promise<RepositoryEnvironmentConfig> {
  const data = await requestJsonValidated(
    `/api/businesses/${businessId}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/environment-variables/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        value,
        ...(options?.usageNote !== undefined ? { usageNote: options.usageNote } : {}),
        ...(options?.sensitive !== undefined ? { sensitive: options.sensitive } : {}),
      }),
    },
    "Failed to save repository environment variable",
    { schema: upsertRepositoryEnvironmentVariableResponseSchema },
  );
  invalidate(apiCacheKeys.repoEnvironment(businessId, repoOwner, repoName));
  return data.loginEnv;
}

export async function importRepositoryEnvironmentVariables(
  businessId: string,
  repoOwner: string,
  repoName: string,
  text: string,
  sensitive = true,
): Promise<{ loginEnv: RepositoryEnvironmentConfig; importedCount: number }> {
  const data = await requestJsonValidated(
    `/api/businesses/${businessId}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/environment-variables/import`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text, sensitive }),
    },
    "Failed to import repository environment variables",
    { schema: importRepositoryEnvironmentVariablesResponseSchema },
  );
  invalidate(apiCacheKeys.repoEnvironment(businessId, repoOwner, repoName));
  return data;
}

export async function deleteRepositoryEnvironmentVariable(
  businessId: string,
  repoOwner: string,
  repoName: string,
  key: string,
): Promise<{ loginEnv: RepositoryEnvironmentConfig | null; changed: boolean }> {
  const result = await requestJsonValidated(
    `/api/businesses/${businessId}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/environment-variables/${encodeURIComponent(key)}`,
    {
      method: "DELETE",
    },
    "Failed to delete repository environment variable",
    { schema: deleteRepositoryEnvironmentVariableResponseSchema },
  );
  invalidate(apiCacheKeys.repoEnvironment(businessId, repoOwner, repoName));
  return result;
}

export async function fetchPersonalSecrets(): Promise<PersonalSecretsConfig | null> {
  const result = await swr(
    apiCacheKeys.personalSecrets(),
    () =>
      requestJsonValidated("/api/settings/personal-secrets", undefined, "Failed to fetch personal secrets", {
        schema: personalSecretsResponseSchema,
      }).then((data) => data.secrets),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function upsertPersonalSecret(
  key: string,
  value: string,
  options?: { usageNote?: string | null; sensitive?: boolean },
): Promise<PersonalSecretsConfig> {
  const data = await requestJsonValidated(
    `/api/settings/personal-secrets/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        value,
        ...(options?.usageNote !== undefined ? { usageNote: options.usageNote } : {}),
        ...(options?.sensitive !== undefined ? { sensitive: options.sensitive } : {}),
      }),
    },
    "Failed to save personal secret",
    { schema: upsertPersonalSecretResponseSchema },
  );
  invalidate(apiCacheKeys.personalSecrets());
  return data.secrets;
}

export async function importPersonalSecrets(
  text: string,
  sensitive = true,
): Promise<{ secrets: PersonalSecretsConfig; importedCount: number }> {
  const data = await requestJsonValidated(
    "/api/settings/personal-secrets/import",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text, sensitive }),
    },
    "Failed to import personal secrets",
    { schema: importPersonalSecretsResponseSchema },
  );
  invalidate(apiCacheKeys.personalSecrets());
  return data;
}

export async function deletePersonalSecret(
  key: string,
): Promise<{ secrets: PersonalSecretsConfig | null; changed: boolean }> {
  const result = await requestJsonValidated(
    `/api/settings/personal-secrets/${encodeURIComponent(key)}`,
    { method: "DELETE" },
    "Failed to delete personal secret",
    { schema: deletePersonalSecretResponseSchema },
  );
  invalidate(apiCacheKeys.personalSecrets());
  return result;
}
