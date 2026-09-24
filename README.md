# nostis-whats-bot (BotBrinzy)

Bot de automação para WhatsApp com painel de controle web integrado, suporte a perfis, campanhas de mensagens/figurinhas, saudação automática no privado e rastreamento de métricas. Aceita várias contas de WhatsApp no mesmo programa.

## Instalação de dependências

```bash
bun install
```

## Execução em modo de desenvolvimento

```bash
bun start
```

O dashboard estará disponível em: `http://localhost:3000`

## Compilação para Executável (.exe) Standalone

Para gerar o executável autossuficiente (`dist/BotBrinzy.exe`) contendo todo o frontend embutido em memória e o ícone do bot:

```bash
bun run build
```

O executável gerado salva todos os dados de forma persistente em `%APPDATA%\BotBrinzy` (sessão de autenticação, regras, perfis, campanhas, métricas) e arquivos temporários em `%TEMP%\BotBrinzy`.

## Várias contas de WhatsApp

A barra à esquerda do painel lista as contas (como os servidores do Discord): clique numa conta para abrir as configurações dela e no **+** para adicionar outro WhatsApp (o painel mostra o QR Code para conectar). Cada conta tem conexão, perfis, regras, campanhas, grupos, métricas, banidos e configurações próprios.

- A conta original continua na pasta de dados de sempre (`%APPDATA%\BotBrinzy`); as outras ficam em `%APPDATA%\BotBrinzy\accounts\<id>`.
- A bolinha no canto de cada conta mostra a situação: verde (conectada, bot ligado), amarela (conectada, bot desligado), azul (esperando o QR Code) e vermelha (desconectada).
- O botão **⋯** no cartão de conexão (lado esquerdo) abre nome, QR Code, desconectar/trocar número e remover conta.

## Segurança: desligar o bot se ninguém responder

O botão **Segurança** no topo do painel (e a opção nas Configurações, onde o prazo é ajustável — padrão 5 min) liga um alarme por conta: se o bot está ligado, chega uma mensagem no privado e ninguém responde nessa conversa dentro do prazo, o bot desliga sozinho e avisa (notificação do Windows + aviso no painel).

- A contagem é por conversa e começa na primeira mensagem sem resposta.
- Responder pelo celular ou pelo computador cancela a contagem daquela conversa. As mensagens que o próprio bot envia (como a saudação automática) **não** contam como resposta.
- Enquanto há uma conversa esperando, o botão mostra a contagem regressiva e a conta ganha um contador na barra lateral.
- Qualquer mensagem privada conta (não só de quem chamou pelo grupo): use um número dedicado ao bot.

## MisticPay: cobrar clientes e sacar

Em **Configurações › MisticPay** (cada conta de WhatsApp tem a sua) ligue a integração e informe o **Client ID** e o **Client Secret** (o botão "Testar conexão" confirma na hora). O campo **Header de autenticação** é opcional: vazio, o sistema monta sozinho o `Authorization: Basic …`; preenchido, ele vale no lugar. O Client Secret e o header ficam só em `mistic.json` na pasta de dados da conta e nunca voltam para o painel.

**Botão flutuante (solto na tela do computador):** no Windows, o programa cria um botão (só o **ícone do bot**, com um selo amarelo quando há cobranças aguardando; o nome do cliente aparece apenas na dica ao passar o mouse) **por cima de qualquer janela** — fora do navegador — que você arrasta para perto da conversa (WhatsApp Web, WhatsApp Desktop...) e que lembra a posição. Ele aparece e some sozinho durante as conversas no privado (ou fica sempre, se preferir), não rouba o foco de onde você está digitando e mostra quantas cobranças estão aguardando pagamento. O WhatsApp não avisa qual conversa está aberta, então "em conversa" significa que houve mensagem — do cliente ou sua — nos últimos 30 minutos (ajustável). Ao clicar, abre uma janelinha (Chrome, Edge ou Brave em modo aplicativo, sem barra de endereço) ao lado do botão com o modal da MisticPay; clicar de novo só traz a janela para a frente. Em Configurações › MisticPay dá para trocar para "dentro da página do painel" (é também o plano B se o botão nativo não conseguir iniciar). O modal tem:

- **Cobrar:** o cliente da conversa já vem selecionado (ou digite outro número, que é conferido no WhatsApp). O bot manda a mensagem da cobrança, o PIX copia e cola sozinho numa mensagem (fácil de copiar) e o QR Code. A **MisticPay exige um CPF do pagador em toda cobrança** (o PIX em si não pede, mas o gateway recusa sem ele: "Um ou mais campos obrigatórios da transação não foram enviados"). Para não precisar pedir o CPF do cliente, salve um **CPF padrão** (em Configurar MisticPay ou, na própria janela de cobrança, digitando o CPF uma vez e marcando "Usar este CPF em todas as cobranças"): a partir daí o campo pode ficar em branco. Digitar outro CPF na cobrança vale só para aquela cobrança.
- **Copiar cobrança (para atender em outro WhatsApp):** ao lado de "Enviar cobrança" há o botão **Copiar cobrança**: ele cria a cobrança na MisticPay **sem mandar nada pelo WhatsApp do bot** e copia o texto (mensagem + PIX copia e cola) para você colar onde atende. O modelo desse texto é configurável em Configurar MisticPay (aceita `{pix}`; sem ele, o código vai no final).
- **Cliente aleatório:** no campo Cliente, escolha **🎲 Cliente aleatório (sem WhatsApp)** quando não tem o número do cliente aqui. O painel sorteia um nome (botão "Sortear outro" para trocar) e preenche a descrição padrão (**Corrida**, configurável); nesse modo só dá para copiar. O CPF continua vindo do CPF padrão salvo: o sistema nunca inventa CPF. O pagamento é acompanhado e avisado normalmente (painel e Windows); só não há agradecimento por WhatsApp, porque não há para quem enviar.
- **Excluir cobrança:** cada cobrança na lista tem o botão **Excluir** (com confirmação). Ela sai do histórico e o sistema para de acompanhá-la. Atenção: a MisticPay não permite cancelar um PIX, então, se o cliente ainda pagar uma cobrança excluída, o dinheiro cai na sua conta mas você não será avisado. Saques não podem ser excluídos por aqui.
- **Saldo sempre em dia:** com o modal aberto, o saldo disponível/bloqueado se atualiza sozinho (a cada ~10 s e logo depois de um pagamento ou saque concluído); o botão de atualizar continua lá para forçar.
- **Pagamento identificado:** o sistema consulta a MisticPay a cada poucos segundos (o webhook não funciona num computador local), avisa no painel e no Windows e manda a mensagem de agradecimento. As consultas respeitam o limite de 60/min da MisticPay e continuam depois de reiniciar o programa.
- **Sacar:** por chave PIX (CPF, CNPJ, e-mail, telefone ou aleatória), com confirmação e trava contra saque duplicado.
- **Cobranças** (histórico com "Verificar", "Reenviar" e "Copiar PIX") e **Extrato** da conta MisticPay, além do saldo disponível/bloqueado e dos dados da conta.

Todas as mensagens ao cliente (cobrança, legenda do QR Code e agradecimento) são configuráveis, com os marcadores `{valor}`, `{nome}`, `{descricao}` e `{numero}`; o envio do QR Code e do agradecimento pode ser desligado.

**Métricas preenchidas pelo pagamento:** quando um pagamento é confirmado, a corrida mais recente daquela pessoa nas **Métricas** (gatilho nos últimos 2 dias, anterior à cobrança) vira **Fechou** e recebe o valor recebido, com o selo "Pago · MisticPay" na linha. Se você já tinha fechado a corrida e digitado um valor, o seu valor fica. Quem nunca disparou um gatilho (chegou direto no privado, ou é "cliente aleatório") não muda nenhuma corrida, mas o pagamento entra no cartão **Recebido hoje** (com o total do mês), que conta todos os pagamentos confirmados. A aba Métricas se atualiza sozinha (a cada ~5 s e na hora em que um pagamento cai), refazendo só as linhas que mudaram, sem atrapalhar o que você está editando. Pagamentos confirmados antes desta versão não são preenchidos retroativamente.

Como o painel agora move dinheiro, ele só aceita pedidos feitos por ele mesmo (`Host`/`Origin` verificados): outros sites abertos no navegador não conseguem acionar cobranças nem saques.

## Testes

```bash
bun run test
bun run typecheck
```
