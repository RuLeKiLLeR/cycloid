import { stringifyError } from "../shared/utils/errors.js";
const DEFAULT_QA_BASE_URL = "https://qa.app.trycycloid.com";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function main(): Promise<void> {
  const baseUrl = trimTrailingSlash(process.env.ARCANIST_API_URL || DEFAULT_QA_BASE_URL);
  const adminToken = process.env.ARCANIST_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("ARCANIST_ADMIN_TOKEN is required");
  }

  const response = await fetch(`${baseUrl}/api/internal/qa/seed`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`QA seed failed (${response.status}): ${JSON.stringify(body)}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(stringifyError(error));
  process.exit(1);
});
