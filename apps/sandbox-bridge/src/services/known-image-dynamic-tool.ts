import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { asRecord } from "../utils/dynamic-tool-helpers.js";
import { desktopScenarioImageRoot, validateDynamicToolImageContentItem } from "./dynamic-tool-image-results.js";
import { createDynamicToolFailure, DYNAMIC_TOOL_ERROR_CODES } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolSpec,
  FirstPartyDynamicToolTextContentItem,
} from "./first-party-dynamic-tools.js";
import {
  KNOWN_IMAGE_FIXTURE_HEIGHT,
  KNOWN_IMAGE_FIXTURE_WIDTH,
  writeKnownImageFixturePng,
} from "./visual-feedback-fixture.js";

export const KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME = "known_image_fixture";

export function isKnownImageFixtureDynamicToolAvailable(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return env.ARCANIST_TEST_DYNAMIC_TOOL_IMAGE_FIXTURE === "1";
}

export function buildKnownImageFixtureDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!isKnownImageFixtureDynamicToolAvailable(env)) return [];
  return [
    {
      namespace: "cycloid",
      name: KNOWN_IMAGE_FIXTURE_DYNAMIC_TOOL_NAME,
      description: "Test-only fixture that returns a deterministic known PNG as model-visible image content.",
      inputSchema: {
        type: "object",
        properties: {
          scenarioId: {
            type: "string",
            description: "Optional scenario id used as the /tmp/phase-evidence/desktop child directory.",
          },
          detail: { type: "string", enum: ["high", "low"] },
        },
        additionalProperties: false,
      },
    },
  ];
}

export async function executeKnownImageFixtureDynamicToolCall(args: unknown): Promise<FirstPartyDynamicToolCallResult> {
  const input = asRecord(args) ?? {};
  const scenarioId =
    typeof input.scenarioId === "string" && input.scenarioId.length > 0 ? input.scenarioId : "known-image-fixture";
  const detail = input.detail === "low" ? "low" : "high";
  let rootDir: string;
  try {
    rootDir = desktopScenarioImageRoot(scenarioId);
  } catch (error) {
    return createDynamicToolFailure(
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      error instanceof Error ? error.message : "Invalid known image fixture scenario id.",
    );
  }

  const rootError = await prepareKnownImageFixtureRoot(rootDir);
  if (rootError) {
    return createDynamicToolFailure(DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, rootError);
  }

  const imagePath = path.join(rootDir, "known-image.png");
  await writeKnownImageFixturePng(imagePath);

  const image = await validateDynamicToolImageContentItem({
    imagePath,
    rootDir,
    label: "Known visual-feedback fixture",
    detail,
  });
  if (!image.ok) {
    return createDynamicToolFailure(DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, image.message);
  }

  const textItem: FirstPartyDynamicToolTextContentItem = {
    type: "inputText",
    text: JSON.stringify({
      ok: true,
      fixture: "known_image",
      image: {
        path: image.item.path,
        mimeType: image.item.mimeType,
        width: KNOWN_IMAGE_FIXTURE_WIDTH,
        height: KNOWN_IMAGE_FIXTURE_HEIGHT,
        bytes: image.item.bytes,
      },
    }),
  };

  return {
    success: true,
    contentItems: [textItem, image.item],
  };
}

async function prepareKnownImageFixtureRoot(rootDir: string): Promise<string | null> {
  const existing = await lstat(rootDir).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) return "Known image fixture root must not be a symlink.";
  if (existing && !existing.isDirectory()) return "Known image fixture root must be a directory.";

  await mkdir(rootDir, { recursive: true });
  const prepared = await lstat(rootDir);
  if (prepared.isSymbolicLink()) return "Known image fixture root must not be a symlink.";
  if (!prepared.isDirectory()) return "Known image fixture root must be a directory.";
  return null;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
