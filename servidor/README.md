# Servidor de licenças do Bot Brinzy

Guarda as contas dos clientes e decide quem pode usar o programa, até quando, com quais funcionalidades e em quantos computadores. O exe (pasta `app/`) só funciona falando com ele.

Esta pasta é independente: copie ela inteira para a sua hospedagem. Ela não vai para o cliente.

## O que precisa

- Uma máquina que fique ligada (uma VPS pequena basta) com o [Bun](https://bun.sh) instalado.
- Um endereço com **HTTPS** apontando para ela (usuário e senha trafegam por ali).

## Colocando no ar

```bash
bun install
bun run gerar-chaves
```

`gerar-chaves` imprime duas chaves:

- **Privada** (`LICENSE_PRIVATE_KEY=...`): copie `.env.example` para `.env` e cole nela. Não vai para mais lugar nenhum.
- **Pública**: cole em `app/src/config/license.ts`, no campo `publicKey`, antes de gerar o exe.

Gere as chaves **uma vez só**. Trocar depois invalida a licença de todos os clientes e exige distribuir um exe novo.

Crie a sua conta de administrador (é a única criada por aqui; as outras entram por convite):

```bash
bun run criar-admin seu-usuario sua-senha
```

Inicie:

```bash
bun start
```

Ao iniciar, o servidor mostra a porta e a chave pública. Confira com `https://seu-endereco/health`, que deve responder `{"ok":true}`.

### HTTPS

O servidor escuta em HTTP na porta do `.env` (8787). Coloque um proxy com certificado na frente. Com o [Caddy](https://caddyserver.com), o arquivo `Caddyfile` inteiro é:

```
licencas.seudominio.com.br {
    reverse_proxy 127.0.0.1:8787
}
```

### Mantendo ligado

Use o gerenciador de serviços da máquina para o servidor voltar sozinho depois de reiniciar. Exemplo com systemd (`/etc/systemd/system/brinzy-licencas.service`):

```ini
[Unit]
Description=Servidor de licencas Bot Brinzy
After=network.target

[Service]
WorkingDirectory=/opt/brinzy/servidor
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

## Configuração (`.env`)

| Variável | Para que serve | Padrão |
|---|---|---|
| `LICENSE_PRIVATE_KEY` | Chave que assina as licenças. Obrigatória. | — |
| `PORT` | Porta em que o servidor escuta. | `8787` |
| `DATA_DIR` | Pasta dos dados. | `./data` |
| `OFFLINE_GRACE_HOURS` | Por quantas horas o exe do cliente funciona sem conseguir falar com o servidor. | `24` |

## Dados e backup

Tudo fica em `DATA_DIR`: `users.json`, `invites.json`, `keys.json` e `sessions.json`. Faça backup dessa pasta e do `.env`. Perder o `.env` (a chave privada) obriga a gerar chaves novas e redistribuir o exe.

## Dia a dia

Você não administra por aqui: entre no programa com a sua conta de administrador e use a aba **Administração**.

- **Novo cliente:** crie um convite e mande o link. Com o programa aberto no computador dele, ele abre o link e escolhe usuário e senha (depois entra no programa com eles). A conta nasce sem nenhuma funcionalidade; libere o plano e defina o prazo.
- **Renovar:** mude a data em "Acesso até", ou gere uma chave de renovação (N dias) para o cliente resgatar sozinho.
- **Cortar:** "Desativar". O programa dele desloga em até 10 minutos e não entra mais.
- **Cliente trocou de computador:** "Liberar computadores". O próximo computador em que ele entrar ocupa a vaga.
- **Cliente com mais de um computador:** aumente o número no campo "Computadores".

## Se o servidor cair

Os clientes continuam usando por `OFFLINE_GRACE_HOURS` desde a última renovação. Passou disso, o programa bloqueia as funcionalidades e o bot de grupo desliga, até o servidor voltar. Ninguém perde dados nem precisa logar de novo.

## Testes

```bash
bun test
bun run typecheck
```
