import { randomBytes } from "node:crypto";

// No 0/O, 1/l/I — safe for reading aloud and typing.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function makeSlug(): string {
  return randomString(10);
}

export function makeToken(): string {
  return randomString(32);
}
