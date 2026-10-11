import { z } from "zod";

const FUTURE_SECRET_TYPES = ["oauth_token", "hmac_sign", "gcp_auth", "pg_dsn", "brokered_token"] as const;

export const ToolsConfigSchema = z.object({
  plugin_dirs: z.array(z.string().min(1)).min(1),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export type SecretSpec = {
  type: "http";
  name: string;
  hosts: string[];
};

const HttpSecretSpecSchema: z.ZodType<SecretSpec> = z.object({
  type: z.literal("http"),
  name: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
});

const SecretSpecSchema = z
  .object({
    type: z.string(),
    name: z.string().min(1).optional(),
    hosts: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if ((FUTURE_SECRET_TYPES as readonly string[]).includes(value.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: `secret type '${value.type}' is declared but not yet supported`,
      });
      return;
    }
    if (value.type !== "http") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: `secret type '${value.type}' is not supported`,
      });
      return;
    }
    const parsed = HttpSecretSpecSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  })
  .transform((value): SecretSpec => ({
    type: "http",
    name: value.name!,
    hosts: value.hosts!,
  }));

export const ToolManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  module: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
  timeouts: z
    .object({
      default_seconds: z.number().positive(),
    })
    .optional(),
  secrets: z.array(SecretSpecSchema).default([]),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;
