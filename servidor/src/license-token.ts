import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "crypto";
import type { Features, UserRole } from "./user-store";

/**
 * O que a licença diz. Vai assinado pro programa do cliente, que confere a assinatura com a chave
 * pública embutida nele — então ninguém consegue fabricar uma licença, nem apontando o programa
 * pra um servidor falso. O mesmo formato é lido em app/src/core/license-token.ts.
 */
export interface LicensePayload {
  v: 1;
  /** Sessão no servidor: é por ela que a licença é renovada (e cortada, se a conta for desativada). */
  sessionId: string;
  userId: string;
  username: string;
  role: UserRole;
  createdAt: number;
  /** null = sem vencimento. */
  expiresAt: number | null;
  features: Features;
  /** Computador pra qual esta licença foi emitida — não vale em outro. */
  deviceId: string;
  issuedAt: number;
  /** Sem conseguir falar com o servidor, o programa segue funcionando com esta licença só até aqui. */
  validUntil: number;
}

function toBase64Url(data: Buffer): string {
  return data.toString("base64url");
}

/** Par de chaves novo, já no formato que vai no .env do servidor (privada) e no app (pública). */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export function loadPrivateKey(base64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64, "base64"), format: "der", type: "pkcs8" });
}

/** A chave pública que corresponde a uma privada, no formato que vai no app. */
export function publicKeyOf(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
}

/** "<dados>.<assinatura>", os dois em base64url. */
export function signLicense(payload: LicensePayload, privateKey: KeyObject): string {
  const body = toBase64Url(Buffer.from(JSON.stringify(payload), "utf-8"));
  return `${body}.${toBase64Url(sign(null, Buffer.from(body), privateKey))}`;
}

/**
 * Lê uma licença, conferindo só a assinatura (não o prazo: uma licença vencida ainda serve pra
 * pedir a renovação). Null = não foi este servidor que emitiu, ou veio adulterada.
 */
export function readLicense(token: string, privateKey: KeyObject): LicensePayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length) return null;
  try {
    if (!verify(null, Buffer.from(body), createPublicKey(privateKey), Buffer.from(signature, "base64url"))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as LicensePayload;
    return payload?.v === 1 && typeof payload.sessionId === "string" ? payload : null;
  } catch {
    return null;
  }
}
