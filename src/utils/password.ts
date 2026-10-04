import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const KEY_LENGTH = 64;

/** Nunca guarde a senha em si — só o hash e o sal usados pra gerá-lo. */
export interface PasswordHash {
  salt: string;
  hash: string;
}

/** Cria o hash de uma senha nova, com um sal aleatório. */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return { salt, hash };
}

/** Confere uma senha contra o hash salvo, em tempo constante (não vaza por quanto tempo demorou). */
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  const candidate = scryptSync(password, stored.salt, KEY_LENGTH);
  const expected = Buffer.from(stored.hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
