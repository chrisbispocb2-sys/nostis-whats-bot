export * from "./paths";

export const CONFIG = {
  defaultPort: 3000,
  defaultButtonText: "📲 Chama no PV",
  allowedReactions: ["❤️", "👍", "🙏", "🚀", "🔥"] as const,
  maxLeads: 500,
  correlationWindowMs: 24 * 60 * 60 * 1000, // 24 horas
  callGapMs: 2 * 60 * 60 * 1000, // 2 horas
  greetingCooldownMs: 2 * 60 * 60 * 1000, // 2 horas: não saúda a mesma pessoa de novo no meio de uma conversa
  maxStickers: 200,
  banWarningMessage: "🚫 Você foi banido(a) pelo bot e não pode mais chamar por aqui.",
  // Login por convite
  sessionMaxAgeMs: 90 * 24 * 60 * 60 * 1000, // 90 dias: teto absoluto da sessão (dura até logout, mas não para sempre)
  loginLockoutAttempts: 5,
  loginLockoutMs: 15 * 60_000,
  inviteExpiryMs: 7 * 24 * 60 * 60 * 1000,
  payTokenTtlMs: 15 * 60_000,
  minPasswordLength: 8,
  keyRedeemWindowMs: 90 * 24 * 60 * 60 * 1000, // prazo pra resgatar uma chave de renovação antes dela expirar sem uso
} as const;
