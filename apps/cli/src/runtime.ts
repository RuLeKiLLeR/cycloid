import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";

import type { CliConfig } from "./config.js";
import { requireConfig } from "./config.js";
import { CliError, EXIT_CODE_INTERRUPTED } from "./errors.js";

// ASCII code points below space (0x20) and DEL (0x7f) are non-printable control chars.
const ASCII_FIRST_PRINTABLE = 32;
const ASCII_DELETE = 127;

const ANSI_CONTROL_SEQUENCE = /\u001b\[[0-9:;<=>?]*[ -/]*[@-~]/g;

export interface RuntimeOptions {
  json?: boolean;
  quiet?: boolean;
  apiUrl?: string;
  token?: string;
  color?: boolean;
  noColor?: boolean;
}

export function getRuntimeOptions(command?: Command, options: RuntimeOptions = {}): RuntimeOptions {
  const globals = command?.optsWithGlobals?.() as RuntimeOptions | undefined;
  const merged = { ...globals, ...options };
  return { ...merged, noColor: merged.noColor === true || merged.color === false };
}

export function isJson(command?: Command, options: RuntimeOptions = {}): boolean {
  return getRuntimeOptions(command, options).json === true;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function emit<T>(
  command: Command | undefined,
  options: RuntimeOptions,
  payload: T,
  printer: (payload: T) => void,
): void {
  if (isJson(command, options)) {
    writeJson(payload);
    return;
  }
  printer(payload);
}

export function resolveBusinessContext(
  command: Command | undefined,
  options: RuntimeOptions = {},
): { runtime: RuntimeOptions; config: CliConfig } {
  const runtime = getRuntimeOptions(command, options);
  return { runtime, config: requireConfig(runtime) };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString();
}

export async function readStdinTrimmed(): Promise<string> {
  return (await readStdin()).trim();
}

export async function resolvePromptInput(
  promptArg: string | undefined,
  options: { promptStdin?: boolean },
): Promise<string> {
  const shouldReadStdin = options.promptStdin === true || promptArg === "-";
  const prompt = shouldReadStdin ? await readStdin() : promptArg;
  if (!prompt || prompt.trim().length === 0) {
    throw new CliError(
      "user",
      "Missing prompt. Pass a prompt argument, use '-' to read stdin, or pass --prompt-stdin.",
    );
  }
  return prompt;
}

export async function confirmOrThrow(message: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("user", "Confirmation required. Re-run with --yes in non-interactive environments.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliError("user", "Aborted.");
    }
  } finally {
    rl.close();
  }
}

export async function readHiddenPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("user", "No interactive terminal available. Re-run with --token-stdin or set ARCANIST_TOKEN.");
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const inputChars: string[] = [];
    let ansiCarry = "";
    let settled = false;

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write("\n");
      resolve(inputChars.join(""));
    };

    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write("\n");
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      const normalized = normalizePromptChunk(chunk, ansiCarry);
      ansiCarry = normalized.carry;
      const text = normalized.text;
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          finish();
          return;
        }
        if (char === "\u0003") {
          fail(new CliError("user", "Interrupted.", { exitCode: EXIT_CODE_INTERRUPTED }));
          return;
        }
        if (char === "\u007F" || char === "\b") {
          if (inputChars.length > 0) {
            inputChars.pop();
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (isControlCharacter(char)) continue;

        inputChars.push(char);
        process.stdout.write("*");
      }
    };

    const onError = (error: Error) => {
      fail(new CliError("user", `Failed to read input: ${error.message}`));
    };

    process.stdout.write(prompt);
    stdin.resume();
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

export function applyColorEnvironment(options: RuntimeOptions): void {
  if (options.noColor === true || !process.stdout.isTTY) {
    process.env.NO_COLOR = "1";
  }
}

export function randomIdempotencyKey(): string {
  return randomUUID();
}

export function assertCycloidSessionMutationAllowed(subcommand: "create" | "send" | "qa" | "respond"): void {
  const role = process.env.ARCANIST_AGENT_ROLE?.trim();
  if (role !== "verification" && role !== "review") return;
  if (subcommand === "respond") {
    throw new CliError(
      "user",
      `\`cycloid sessions respond\` is disabled inside ${role} sessions because read-only agents cannot mutate the session under review.`,
      {
        hint: "Report the unanswered question as a verification blocker instead.",
      },
    );
  }
  throw new CliError(
    "user",
    `\`cycloid sessions ${subcommand}\` is disabled inside ${role} sessions because nested Cycloid sessions are not observable to read-only agents.`,
    {
      hint: "Use direct local/sandbox evidence instead, or report a verification gap rather than spawning another Cycloid session.",
    },
  );
}

function normalizePromptChunk(chunk: Buffer | string, carry: string): { text: string; carry: string } {
  const raw = carry + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  let text = "";
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];
    if (char !== "\u001b") {
      text += char;
      index += 1;
      continue;
    }

    const sequence = matchAnsiControlSequence(raw, index);
    if (sequence.kind === "incomplete") {
      return { text, carry: raw.slice(index) };
    }
    if (sequence.kind === "complete") {
      index = sequence.nextIndex;
      continue;
    }

    index += 1;
  }

  return { text, carry: "" };
}

function matchAnsiControlSequence(
  text: string,
  startIndex: number,
): { kind: "none" | "incomplete" | "complete"; nextIndex: number } {
  if (startIndex + 1 >= text.length) {
    return { kind: "incomplete", nextIndex: startIndex };
  }
  if (text[startIndex + 1] !== "[") {
    return { kind: "none", nextIndex: startIndex + 1 };
  }

  ANSI_CONTROL_SEQUENCE.lastIndex = startIndex;
  const match = ANSI_CONTROL_SEQUENCE.exec(text);
  if (match && match.index === startIndex) {
    return { kind: "complete", nextIndex: startIndex + match[0].length };
  }

  return { kind: "incomplete", nextIndex: startIndex };
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < ASCII_FIRST_PRINTABLE || code === ASCII_DELETE;
}
