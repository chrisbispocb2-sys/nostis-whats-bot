export const state = {
  // Contas de WhatsApp (o resto do estado abaixo é sempre da conta ativa)
  accounts: [],
  activeAccountId: null,

  allGroups: [],
  enabledSet: new Set(),
  groupDelays: new Map(),

  allRules: [],
  editingRuleId: null,

  allLeads: [],
  allBans: [],
  allCallers: [],
  metricsPageSize: 15,
  metricsPage: 1,

  allProfiles: [],
  activeProfileId: null,

  allCampaigns: [],
  editingCampaignId: null,
  editingCampaignMedia: null,
  campaignSelectedGroups: new Set(),
  campaignHasNewMediaFile: false,
  campaignMediaRemoved: false,
  campaignPendingGalleryStickerId: null,
  campaignPollTimers: new Map(),
};

/**
 * Esquece tudo que era da conta anterior (chamado ao trocar de conta), pra dados
 * de uma conta nunca aparecerem na tela de outra.
 */
export function resetAccountState() {
  for (const timer of state.campaignPollTimers.values()) clearInterval(timer);
  state.campaignPollTimers.clear();

  state.allGroups = [];
  state.enabledSet = new Set();
  state.groupDelays = new Map();

  state.allRules = [];
  state.editingRuleId = null;

  state.allLeads = [];
  state.allBans = [];
  state.allCallers = [];
  state.metricsPage = 1;

  state.allProfiles = [];
  state.activeProfileId = null;

  state.allCampaigns = [];
  state.editingCampaignId = null;
  state.editingCampaignMedia = null;
  state.campaignSelectedGroups = new Set();
  state.campaignHasNewMediaFile = false;
  state.campaignMediaRemoved = false;
  state.campaignPendingGalleryStickerId = null;
}
