export function getOptionalEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

export function requireEnv(name: string): string {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function isProductionLike(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}
