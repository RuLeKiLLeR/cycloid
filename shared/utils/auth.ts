/**
 * Parse the bearer token from a request's Authorization header.
 *
 * Accepts the standard `Authorization: Bearer <token>` form (case-insensitive
 * scheme). Returns the trimmed token, or null if the header is missing or
 * malformed.
 */
export function parseBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}
