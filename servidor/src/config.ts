import { resolve } from "path";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CONFIG = {
  port: positiveNumber(process.env["PORT"], 8787),
  dataDir: resolve(process.env["DATA_DIR"] || "./data"),
  /** Chave privada Ed25519 (PKCS8/DER em base64) que assina as licenças — ver scripts/gerar-chaves.ts. */
  privateKey: (process.env["LICENSE_PRIVATE_KEY"] || "").trim(),
  /** Por quanto tempo uma licença emitida vale sem o programa conseguir falar de novo com o servidor. */
  offlineGraceMs: positiveNumber(process.env["OFFLINE_GRACE_HOURS"], 24) * HOUR_MS,
  minPasswordLength: 8,
  loginLockoutAttempts: 5,
  loginLockoutMs: 15 * 60_000,
  inviteExpiryMs: 7 * DAY_MS,
  /** Prazo pra resgatar uma chave de renovação antes de ela expirar sem uso. */
  keyRedeemWindowMs: 90 * DAY_MS,
  /** Sem renovar a licença por mais que isso, a pessoa deixa de contar como "online" (o programa renova a cada ~10 min). */
  onlineThresholdMs: 25 * 60_000,
  /** Em quantos computadores uma conta de cliente pode estar ao mesmo tempo (o administrador muda por usuário). */
  defaultMaxDevices: 1,
} as const;
