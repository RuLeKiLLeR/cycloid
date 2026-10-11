import { parse, TomlError } from "smol-toml";

export class ToolTomlParseError extends Error {
  readonly sourcePath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(sourcePath: string, message: string, options: { line?: number; column?: number }) {
    const location = options.line ? `:${options.line}${options.column ? `:${options.column}` : ""}` : "";
    super(`${sourcePath}${location}: ${message}`);
    this.name = "ToolTomlParseError";
    this.sourcePath = sourcePath;
    this.line = options.line;
    this.column = options.column;
  }
}

export function parseToml(text: string, sourcePath: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ToolTomlParseError(sourcePath, firstLine(error.message), {
        line: error.line,
        column: error.column,
      });
    }
    throw new ToolTomlParseError(sourcePath, error instanceof Error ? error.message : "invalid TOML", {});
  }
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? message;
}
