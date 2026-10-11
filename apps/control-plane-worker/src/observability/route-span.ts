import type {
  OptionalSpanAttributes,
  OptionalSpanAttributeValue,
  SpanAttributes,
} from "../../../../shared/observability/trace.js";
import type { AuthInfo } from "../types";
import { endSpan, runInSpan, startSpan } from "./context";

export interface RouteSpanRecorder {
  setAttribute(key: string, value: OptionalSpanAttributeValue): void;
  setAttributes(attributes: OptionalSpanAttributes): void;
}

class MutableRouteSpanRecorder implements RouteSpanRecorder {
  private readonly attributes: SpanAttributes = {};

  setAttribute(key: string, value: OptionalSpanAttributeValue): void {
    if (value === undefined || value === null) {
      return;
    }
    this.attributes[key] = value;
  }

  setAttributes(attributes: OptionalSpanAttributes): void {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
  }

  snapshot(): SpanAttributes {
    return { ...this.attributes };
  }
}

function buildRouteSpanAttributes(
  auth: AuthInfo | null | undefined,
  attributes: SpanAttributes | undefined,
): SpanAttributes {
  return {
    ...(auth?.userId ? { "user.id": auth.userId } : {}),
    ...(auth?.user?.businessId ? { "business.id": auth.user.businessId } : {}),
    "cache.status": "n/a",
    ...(attributes ?? {}),
  };
}

function resolveRouteSpanStatus(result: unknown): "ok" | "error" {
  if (result instanceof Response && result.status >= 500) {
    return "error";
  }
  return "ok";
}

export async function withRouteSpan<T>(
  name: string,
  options: {
    auth?: AuthInfo | null;
    attributes?: SpanAttributes;
  },
  fn: (span: RouteSpanRecorder) => Promise<T>,
): Promise<T> {
  const recorder = new MutableRouteSpanRecorder();
  const span = startSpan(name, buildRouteSpanAttributes(options.auth, options.attributes));

  return runInSpan(span, async () => {
    try {
      const result = await fn(recorder);
      endSpan(span, resolveRouteSpanStatus(result), recorder.snapshot());
      return result;
    } catch (err) {
      endSpan(span, "error", {
        ...recorder.snapshot(),
        "error.message": String(err),
      });
      throw err;
    }
  }) as Promise<T>;
}
