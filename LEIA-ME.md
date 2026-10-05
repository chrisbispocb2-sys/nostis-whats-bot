# Bot Brinzy — o que vai para onde

O projeto tem duas partes, cada uma numa pasta:

| Pasta | O que é | Para onde vai |
|---|---|---|
| `app/` | O bot e o painel. É daqui que sai o `BotBrinzy.exe`. | Para o computador de cada cliente (e o seu). |
| `servidor/` | O controle de licenças: contas, prazo, funcionalidades, convites, chaves e computadores liberados. | Para a sua hospedagem (VPS). Nunca para o cliente. |

> Enquanto você não rodar `organizar-pastas.ps1`, o conteúdo de `app/` ainda está solto na raiz (`src/`, `scripts/`, `package.json`...). Rode o script uma vez, **com o bot fechado**:
> `powershell -ExecutionPolicy Bypass -File organizar-pastas.ps1`

## Como as duas partes conversam

1. O cliente abre o exe e entra com usuário e senha.
2. O exe manda isso para o servidor, junto com o identificador do computador.
3. O servidor confere e devolve uma **licença assinada**: quem é, até quando vale, quais funcionalidades tem e para qual computador.
4. O exe confere a assinatura com a chave pública embutida nele e renova a licença a cada 10 minutos.

O que isso garante:

- **O computador do cliente não guarda nada que dê para adulterar.** Usuário, senha, prazo e funcionalidades ficam só no servidor; mexer nos arquivos locais ou apontar o exe para um servidor falso não libera nada.
- **Você corta o acesso de longe.** Desativou a conta ou venceu o prazo: na renovação seguinte (até 10 min) o painel bloqueia e o bot de grupo desliga.
- **Uma conta, um computador** (ajustável por cliente). Para o cliente trocar de máquina, você clica em "Liberar computadores".
- **Sem internet o cliente não fica na mão na hora**: o exe segue funcionando com a última licença por 24 horas (configurável); depois bloqueia até voltar a falar com o servidor.

A aba **Administração** do painel continua igual, mas agora só repassa para o servidor. Você administra todos os clientes de qualquer computador onde entrar com a sua conta de administrador.

## Passo a passo para colocar no ar

1. **Organize as pastas** (uma vez, bot fechado): `organizar-pastas.ps1`.
2. **Suba o servidor** seguindo [servidor/README.md](servidor/README.md): gerar as chaves, criar o seu administrador, deixar rodando com HTTPS.
3. **Aponte o app para o servidor**: em `app/src/config/license.ts`, preencha `serverUrl` (com `https://`) e `publicKey` (a chave pública que o servidor mostra ao iniciar).
4. **Gere o exe**: `cd app` e `bun run build`. Sem o passo 3 o build se recusa a gerar.
5. **Entre no exe com o seu administrador**, crie um convite na aba Administração e mande o link para o cliente. Depois que ele se cadastrar, defina o prazo e as funcionalidades dele.

## O que ainda não está coberto

- **Só o bot de grupo desliga sozinho** quando a licença cai. Campanhas e o assistente de corrida ficam bloqueados no painel, mas o que já estava em andamento termina.
- **O que já estava guardado no modo antigo não migra**: usuários, convites e chaves criados no painel local (`%APPDATA%\BotBrinzy\users.json` etc.) não vão para o servidor. Recrie as contas por convite.
- **Um exe pode ser alterado por quem souber**: a licença impede o uso comum sem pagar, não um ataque dedicado ao executável.
