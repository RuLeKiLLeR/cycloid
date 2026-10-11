interface ResolveRequiredBusinessIdOptions {
  ownerUserId: string;
  businessId?: string | null;
  sessionId?: string | null;
  operation: string;
}

export class MissingBusinessIdError extends Error {
  constructor(options: ResolveRequiredBusinessIdOptions) {
    super(
      `Missing business_id for ${options.operation} (sessionId=${options.sessionId ?? "n/a"}, ownerUserId=${options.ownerUserId})`,
    );
    this.name = "MissingBusinessIdError";
  }
}

export async function getSessionIndexBusinessId(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT business_id FROM session_index WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ business_id: string | null }>();
  return row?.business_id ?? null;
}

async function getOwnerBusinessId(db: D1Database, ownerUserId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT business_id FROM users WHERE id = ? LIMIT 1")
    .bind(ownerUserId)
    .first<{ business_id: string | null }>();
  return row?.business_id ?? null;
}

export async function resolveRequiredBusinessId(
  db: D1Database,
  options: ResolveRequiredBusinessIdOptions,
): Promise<string> {
  const explicitBusinessId = options.businessId ?? null;
  if (explicitBusinessId) return explicitBusinessId;

  if (options.sessionId) {
    const indexedBusinessId = await getSessionIndexBusinessId(db, options.sessionId);
    if (indexedBusinessId) return indexedBusinessId;
  }

  const ownerBusinessId = await getOwnerBusinessId(db, options.ownerUserId);
  if (ownerBusinessId) return ownerBusinessId;

  throw new MissingBusinessIdError(options);
}
