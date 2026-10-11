const MAX_SUMMARY_LENGTH = 80;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function generateToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "read": {
      const filePath = input.filePath as string | undefined;
      return filePath ? truncate(`Reading ${filePath}`, MAX_SUMMARY_LENGTH) : tool;
    }
    case "write": {
      const filePath = input.filePath as string | undefined;
      return filePath ? truncate(`Writing ${filePath}`, MAX_SUMMARY_LENGTH) : tool;
    }
    case "edit": {
      const filePath = input.filePath as string | undefined;
      return filePath ? truncate(`Editing ${filePath}`, MAX_SUMMARY_LENGTH) : tool;
    }
    case "bash": {
      const command = input.command as string | undefined;
      return command ? truncate(command, MAX_SUMMARY_LENGTH) : tool;
    }
    case "glob": {
      const pattern = input.pattern as string | undefined;
      return pattern ? truncate(`Finding ${pattern}`, MAX_SUMMARY_LENGTH) : tool;
    }
    case "grep": {
      const pattern = input.pattern as string | undefined;
      return pattern ? truncate(`Searching for ${pattern}`, MAX_SUMMARY_LENGTH) : tool;
    }
    case "agent": {
      const description = input.description as string | undefined;
      return description ? truncate(description, MAX_SUMMARY_LENGTH) : tool;
    }
    case "batch": {
      const toolCalls = Array.isArray(input.tool_calls) ? input.tool_calls : null;
      if (!toolCalls || toolCalls.length === 0) return tool;
      const parts = toolCalls.flatMap((tc) => {
        const record = recordOrNull(tc);
        if (!record) return [];
        const name = typeof record.tool === "string" && record.tool.length > 0 ? record.tool : "unknown";
        return [generateToolSummary(name, recordOrNull(record.parameters) ?? {})];
      });
      if (parts.length === 0) return tool;
      return truncate(parts.join(", "), MAX_SUMMARY_LENGTH);
    }
    case "todowrite": {
      const todos = Array.isArray(input.todos) ? input.todos : null;
      if (!todos || todos.length === 0) return tool;
      const items = todos.flatMap((todo) => {
        const record = recordOrNull(todo);
        if (!record) return [];
        if (typeof record.content === "string" && record.content.length > 0) return [record.content];
        if (typeof record.title === "string" && record.title.length > 0) return [record.title];
        return [];
      });
      return items.length > 0 ? truncate(items.join(", "), MAX_SUMMARY_LENGTH) : tool;
    }
    default: {
      for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0) {
          return truncate(val, MAX_SUMMARY_LENGTH);
        }
      }
      return tool;
    }
  }
}
