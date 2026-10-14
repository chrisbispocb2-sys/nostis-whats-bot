/**
 * Onde está o servidor de licenças (pasta `servidor/`) e a chave pública dele.
 *
 * - `serverUrl`: endereço do servidor, com https (ex.: "https://licencas.seudominio.com.br").
 * - `publicKey`: a chave PÚBLICA que o servidor mostra ao iniciar (ou que "bun run gerar-chaves"
 *   imprime). É com ela que o programa confere que a licença veio mesmo do seu servidor.
 *
 * Com `serverUrl` vazio o programa roda em "modo local" (contas guardadas no próprio computador):
 * quem abre o exe cria a própria conta de administrador. `bun run build` gera o exe assim mesmo,
 * mas avisa — não é pra entregar a clientes.
 */
export const LICENSE: { serverUrl: string; publicKey: string } = {
  serverUrl: "https://licensa.structurerp.com.br",
  publicKey: "MCowBQYDK2VwAyEARW4EFWvR8BlkJgVj2mShgG/U7zwUmdyuHDDn/gBu1aQ=",
};
