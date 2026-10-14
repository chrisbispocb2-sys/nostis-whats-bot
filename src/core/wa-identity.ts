import { createHash } from "crypto";
import { Curve } from "baileys-joss";
import type { WASocket } from "baileys-joss";
import type { WorkspaceIdentity } from "./auth-provider";
import { phoneFromJid } from "../utils/jid";

/** O que o computador assina pra provar que a credencial é dele — o mesmo texto que o servidor monta (servidor/src/wa-proof.ts). */
function proofMessage(sessionId: string, timestamp: number): Buffer {
  return Buffer.from(`brinzy-wa-proof|${sessionId}|${timestamp}`, "utf-8");
}

const base64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");

/**
 * Com qual WhatsApp esta conexão está logada, e a prova disso.
 *
 * Ao ler o QR Code, o celular assina a chave deste computador com a chave de identidade da conta
 * (`creds.account`). Todo computador conectado na mesma conta tem a assinatura da MESMA chave — é
 * por ela que o servidor de licenças reconhece, sozinho, que duas pessoas atendem no mesmo
 * WhatsApp. Sem essa credencial (conexão ainda não concluída), sobra só o número.
 *
 * Null = ainda não dá pra saber nem o número (não conectou).
 */
export function workspaceIdentityOf(sock: WASocket): WorkspaceIdentity | null {
  const jid = sock.user?.id;
  if (!jid) return null;
  const identity: WorkspaceIdentity = { phone: phoneFromJid(jid) };

  const creds = sock.authState?.creds;
  const account = creds?.account;
  const deviceKeys = creds?.signedIdentityKey;
  if (account?.details?.length && account.accountSignatureKey?.length && account.accountSignature?.length && deviceKeys?.private?.length && deviceKeys.public?.length) {
    const accountKey = Buffer.from(account.accountSignatureKey);
    identity.account = {
      id: createHash("sha256").update(accountKey).digest("hex").slice(0, 32),
      prove(sessionId) {
        const timestamp = Date.now();
        return {
          details: base64(account.details!),
          accountKey: base64(accountKey),
          accountSignature: base64(account.accountSignature!),
          deviceKey: base64(deviceKeys.public),
          timestamp,
          signature: base64(Curve.sign(deviceKeys.private, proofMessage(sessionId, timestamp))),
        };
      },
    };
  }
  return identity;
}
