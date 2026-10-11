export async function getUserGitIdentity(
  db: D1Database,
  userId: string,
): Promise<{ login: string | null; name: string; email: string } | null> {
  const row = await db
    .prepare("SELECT github_id, login, name, email FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ github_id: number | null; login: string | null; name: string | null; email: string | null }>();

  if (!row) return null;

  return {
    login: row.login,
    name: row.name || row.login || "Cycloid User",
    email:
      row.email ||
      (row.login && row.github_id ? `${row.github_id}+${row.login}@users.noreply.github.com` : null) ||
      (row.login ? `${row.login}@users.noreply.github.com` : "bot@trycycloid.com"),
  };
}
