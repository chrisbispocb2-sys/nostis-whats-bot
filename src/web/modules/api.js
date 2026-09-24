import { state } from "./state.js";

/**
 * Endereço de uma rota da conta de WhatsApp ativa. Serve pra chamadas manuais
 * (fetch, <img src>...) que não passam pelo `api()` abaixo.
 */
export function accountUrl(path, accountId = state.activeAccountId) {
  return `/accounts/${encodeURIComponent(accountId)}${path}`;
}

/**
 * Wrapper de fetch: devolve o JSON da resposta ou lança um Error com uma
 * mensagem já pronta para o usuário (usada direto nos toasts).
 *
 * Rotas que começam com "/accounts" (as contas em si) ou "/overlay" (o botão
 * solto na tela) não pertencem a uma conta; todas as outras (`/rules`,
 * `/groups`...) vão para a conta ativa no momento da chamada.
 */
export async function api(path, { method = "GET", body } = {}) {
  const scoped = !path.startsWith("/accounts") && !path.startsWith("/overlay");
  const accountId = state.activeAccountId;
  if (scoped && !accountId) throw new Error("Nenhuma conta de WhatsApp selecionada.");

  const init = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(scoped ? accountUrl(path, accountId) : path, init);
  } catch {
    throw new Error("Sem conexão com o bot. Verifique se o programa continua aberto.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Falha na requisição (status ${res.status}).`);

  // Leitura de uma conta que já não é a da tela (o usuário trocou no meio da chamada):
  // descarta em silêncio pra não pintar dados de uma conta na tela de outra. Gravações
  // não entram aqui: elas precisam terminar normalmente.
  if (scoped && method === "GET" && state.activeAccountId !== accountId) return new Promise(() => {});

  return data;
}
