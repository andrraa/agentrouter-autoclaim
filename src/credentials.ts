export type Credentials = { email: string; password: string };

export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}
