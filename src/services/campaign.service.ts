import { readFileSync } from "fs";
import type { WASocket } from "baileys-joss";
import type { Campaign } from "../core/campaign-store";
import { logger } from "../utils/logger";
import { sleep } from "../utils/sleep";

/** O que o envio precisa da conta que está enviando a campanha. */
export interface CampaignSendContext {
  /** Caminho da mídia da campanha no disco, ou null se ela não tem mídia. */
  mediaPath: string | null;
  groupName(jid: string): string;
}

export interface CampaignSendResult {
  jid: string;
  groupName: string;
  ok: boolean;
  error?: string;
}

export interface CampaignSendState {
  status: "idle" | "sending" | "done";
  total: number;
  sent: number;
  results: CampaignSendResult[];
  startedAt: number | null;
  finishedAt: number | null;
}

const sendStates = new Map<string, CampaignSendState>();

function idleState(): CampaignSendState {
  return { status: "idle", total: 0, sent: 0, results: [], startedAt: null, finishedAt: null };
}

export function getSendState(campaignId: string): CampaignSendState {
  return sendStates.get(campaignId) ?? idleState();
}

export function isSending(campaignId: string): boolean {
  return sendStates.get(campaignId)?.status === "sending";
}

/**
 * Envia a campanha para cada grupo, com um intervalo entre mensagens para
 * reduzir o risco de o número ser marcado como spam pelo WhatsApp.
 * Roda em segundo plano; o progresso é consultado via getSendState().
 */
export async function sendCampaign(
  sock: WASocket,
  campaign: Campaign,
  context: CampaignSendContext
): Promise<void> {
  if (isSending(campaign.id)) return;

  const state: CampaignSendState = {
    status: "sending",
    total: campaign.groupJids.length,
    sent: 0,
    results: [],
    startedAt: Date.now(),
    finishedAt: null,
  };
  sendStates.set(campaign.id, state);

  const mediaBuffer = context.mediaPath ? readFileSync(context.mediaPath) : null;

  for (let i = 0; i < campaign.groupJids.length; i++) {
    const jid = campaign.groupJids[i]!;
    const groupName = context.groupName(jid);

    try {
      if (campaign.mediaType === "sticker" && mediaBuffer) {
        await sock.sendMessage(jid, { sticker: mediaBuffer });
        if (campaign.message) {
          await sock.sendMessage(jid, { text: campaign.message });
        }
      } else if (campaign.mediaType === "image" && mediaBuffer) {
        await sock.sendMessage(jid, {
          image: mediaBuffer,
          caption: campaign.message || undefined,
        });
      } else {
        await sock.sendMessage(jid, { text: campaign.message });
      }
      state.results.push({ jid, groupName, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, jid }, "Falha ao enviar propaganda para grupo");
      state.results.push({ jid, groupName, ok: false, error: message });
    }

    state.sent++;

    const isLast = i === campaign.groupJids.length - 1;
    if (!isLast) await sleep(campaign.intervalSeconds * 1000);
  }

  state.status = "done";
  state.finishedAt = Date.now();
}
