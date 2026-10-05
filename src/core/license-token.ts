import { createPublicKey, verify } from "crypto";
import type { Features, UserRole } from "./user-store";

/** O que a licença diz — o mesmo formato que o servidor assina (servidor/src/license-token.ts). */
export interface LicensePayload {
  v: 1;
  sessionId: string;
  userId: string;
  username: string;
  role: UserRole;
  createdAt: number;
  /** null = sem vencimento. */
  expiresAt: number | null;
  features: Features;
  /** Computador pra qual a licença foi emitida — não vale em outro. */
  deviceId: string;
  issuedAt: number;
  /** Sem conseguir falar com o servidor, o programa segue funcionando com esta licença só até aqui. */
  validUntil: number;
}

/**
 * Lê uma licença ("<dados>.<assinatura>"), conferindo a assinatura com a chave pública do servidor.
 * Null = não foi o servidor de licenças que emitiu (ou alguém mexeu nela). O prazo não é conferido
 * aqui: quem usa decide o que fazer com uma licença já vencida.
 */
export function verifyLicense(token: string, publicKeyBase64: string): LicensePayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length) return null;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(body), publicKey, Buffer.from(signature, "base64url"))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as LicensePayload;
    return payload?.v === 1 && typeof payload.userId === "string" && typeof payload.deviceId === "string" ? payload : null;
  } catch {
    return null;
  }
}
