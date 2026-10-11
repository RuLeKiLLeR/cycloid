export type BusinessRole = "admin" | "member";

export function toBusinessRole(value: string | null | undefined): BusinessRole | null {
  return value === "admin" || value === "member" ? value : null;
}
