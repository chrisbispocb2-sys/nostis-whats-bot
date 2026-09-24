import type { AccountManager } from "../core/account-manager";
import type { Overlay } from "../core/overlay";
import { handleAccountRoutes } from "./account.routes";
import { handleOverlayRoutes } from "./overlay.routes";
import { handleBotRoutes } from "./bot.routes";
import { handleProfileRoutes } from "./profile.routes";
import { handleGroupRoutes } from "./group.routes";
import { handleRuleRoutes } from "./rule.routes";
import { handleCampaignRoutes } from "./campaign.routes";
import { handleLeadRoutes } from "./lead.routes";
import { handleStickerRoutes } from "./sticker.routes";
import { handleSettingsRoutes } from "./settings.routes";
import { handleMisticRoutes } from "./mistic.routes";

const ACCOUNT_SCOPED_HANDLERS = [
  handleBotRoutes,
  handleProfileRoutes,
  handleGroupRoutes,
  handleRuleRoutes,
  handleCampaignRoutes,
  handleLeadRoutes,
  handleStickerRoutes,
  handleSettingsRoutes,
  handleMisticRoutes,
];

/**
 * Tudo que o painel faz é dentro de uma conta: `/accounts/:id/<rota>`. A rota
 * de dentro (`/rules`, `/status`...) é tratada como sempre, só que sobre os
 * dados daquela conta.
 */
export async function handleApiRequest(
  req: Request,
  url: URL,
  manager: AccountManager,
  overlay?: Overlay
): Promise<Response | null> {
  if (overlay) {
    const overlayRes = await handleOverlayRoutes(req, url, overlay);
    if (overlayRes) return overlayRes;
  }

  const accountRes = await handleAccountRoutes(req, url, manager);
  if (accountRes) return accountRes;

  const match = url.pathname.match(/^\/accounts\/([^/]+)(\/.+)$/);
  if (!match) return null;

  const account = manager.get(decodeURIComponent(match[1]!));
  if (!account) return Response.json({ error: "Conta não encontrada." }, { status: 404 });

  const scoped = new URL(url);
  scoped.pathname = match[2]!;

  for (const handle of ACCOUNT_SCOPED_HANDLERS) {
    const res = await handle(req, scoped, account);
    if (res) return res;
  }

  return null;
}
