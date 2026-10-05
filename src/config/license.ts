/**
 * Onde está o servidor de licenças (pasta `servidor/`) e a chave pública dele.
 *
 * - `serverUrl`: endereço do servidor, com https (ex.: "https://licencas.seudominio.com.br").
 * - `publicKey`: a chave PÚBLICA que o servidor mostra ao iniciar (ou que "bun run gerar-chaves"
 *   imprime). É com ela que o programa confere que a licença veio mesmo do seu servidor.
 *
 * Com `serverUrl` vazio o programa roda em "modo local" (contas guardadas no próprio computador),
 * que serve só pra desenvolver: `bun run build` se recusa a gerar o exe assim.
 */
export const LICENSE: { serverUrl: string; publicKey: string } = {
  serverUrl: "",
  publicKey: "",
};
