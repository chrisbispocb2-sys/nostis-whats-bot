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

O build exige o servidor de licenças configurado em `src/config/license.ts` (`serverUrl` e `publicKey`); sem isso ele se recusa a gerar o exe. Para gerar um exe sem controle de acesso, só para testar: `bun run build --sem-licenca`.

O executável gerado salva todos os dados de forma persistente em `%APPDATA%\BotBrinzy` (sessão de autenticação, regras, perfis, campanhas, métricas) e arquivos temporários em `%TEMP%\BotBrinzy`.

### Controle de acesso

Quem controla o acesso de cada cliente é o **servidor de licenças** (pasta `servidor/`, ver o `LEIA-ME.md` na raiz do projeto). O exe não guarda usuário, senha, prazo nem funcionalidades: no login ele recebe do servidor uma licença assinada para aquele computador e a renova a cada 10 minutos.

- Pelo painel de Administração (que repassa tudo ao servidor), o administrador define até quando cada usuário pode usar o sistema, quais funcionalidades tem liberadas e em quantos computadores pode entrar.
- Vencido o prazo, a pessoa continua entrando, só que sem nenhuma funcionalidade liberada, até o administrador renovar ou ela resgatar uma chave de renovação.
- Conta desativada ou computador liberado para outro: o programa desloga na renovação seguinte.
- Sem conseguir falar com o servidor, o programa segue com a última licença pela tolerância configurada nele (24 h por padrão); depois bloqueia tudo e desliga o bot de grupo até renovar.

Com `serverUrl` vazio (`bun start` em desenvolvimento) o programa roda em **modo local**: as contas ficam neste computador e a primeira conta criada vira administradora. Serve só para desenvolver.

## Várias contas de WhatsApp

A barra à esquerda do painel lista as contas (como os servidores do Discord): clique numa conta para abrir as configurações dela e no **+** para adicionar outro WhatsApp (o painel mostra o QR Code para conectar). Cada conta tem conexão, perfis, regras, campanhas, grupos, métricas, banidos e configurações próprios.

- A conta original continua na pasta de dados de sempre (`%APPDATA%\BotBrinzy`); as outras ficam em `%APPDATA%\BotBrinzy\accounts\<id>`.
- A bolinha no canto de cada conta mostra a situação: verde (conectada, bot ligado), amarela (conectada, bot desligado), azul (esperando o QR Code) e vermelha (desconectada).
- O botão **⋯** no cartão de conexão (lado esquerdo) abre nome, QR Code, desconectar/trocar número e remover conta.

## Segurança: desligar o bot se ninguém responder

O botão **Segurança** no topo do painel (e a opção nas Configurações, onde o prazo é ajustável — padrão 5 min) liga um alarme por conta: se o bot está ligado, chega uma mensagem no privado e ninguém responde nessa conversa dentro do prazo, o bot desliga sozinho e avisa (notificação do Windows + aviso no painel).

- **Só conta quem foi chamado num grupo há pouco** (a mesma janela de 24h usada nas Métricas): a primeira mensagem dela no privado depois disso é que inicia a contagem. Mensagens de quem nunca chamou num grupo, ou uma pessoa insistindo/agradecendo depois de já ter sido atendida, não iniciam (nem reiniciam) nada.
- Responder pelo celular ou pelo computador cancela a contagem daquela conversa. As mensagens que o próprio bot envia (como a saudação automática) **não** contam como resposta.
- Enquanto há uma conversa esperando, o botão mostra a contagem regressiva e a conta ganha um contador na barra lateral.
- Se a pessoa for chamada de novo num grupo depois de já ter sido atendida, a próxima mensagem dela no privado volta a contar normalmente.

## Recado automático: não deixar o cliente sem resposta com o bot desligado

O botão **Recado** no topo do painel (e a opção nas Configurações, logo abaixo da Segurança, onde a mensagem é editável) liga um aviso por conta: enquanto o bot estiver **desligado** — por você ou pela Segurança — quem chamar no privado recebe uma mensagem automática avisando que não há ninguém para atender agora.

- **Ligar o Recado desliga o bot na hora**, se ele estiver ligado: o recado só faz sentido com o bot desligado, então ligar o botão já deixa tudo pronto.
- Cada pessoa recebe a mensagem **uma vez só**, mesmo insistindo — ligar o bot de novo "rearma" o aviso para a próxima vez que ele desligar.
- Números banidos e os da lista "sem resposta" não recebem o recado.
- A mensagem é configurável nas Configurações (com um texto padrão pronto e um botão para restaurá-lo).

## Métricas: quem chama, mesmo sem gatilho de grupo

Além de quem dispara um gatilho num grupo com "Rastrear métricas" ligado, **toda mensagem privada de um cliente novo entra nas Métricas** — não precisa ter chamado num grupo, nem o bot estar ligado (só a conta precisa estar online). Quem não veio de um grupo aparece com **"Direto no privado"** no lugar do nome do grupo.

- **Não duplica:** enquanto a corrida da pessoa continuar **Pendente**, novas mensagens dela reaproveitam a mesma linha. Só depois de a corrida ser fechada (ou marcada como "Não fechou") é que a próxima mensagem abre uma corrida nova.
- Reconhece a pessoa por telefone (tolera o "9" extra do celular) e por LID, igual ao resto do sistema.
- **Pagamento pela MisticPay fecha a corrida e preenche o valor sozinho**, do mesmo jeito que já acontecia para quem veio de um grupo — não precisa de gatilho nenhum para isso funcionar, só que a pessoa tenha uma corrida pendente nas métricas quando o pagamento cair.
- Números banidos não entram.

## MisticPay: cobrar clientes e sacar

Em **Configurações › MisticPay** (cada conta de WhatsApp tem a sua) ligue a integração e informe o **Client ID** e o **Client Secret** (o botão "Testar conexão" confirma na hora). O campo **Header de autenticação** é opcional: vazio, o sistema monta sozinho o `Authorization: Basic …`; preenchido, ele vale no lugar. O Client Secret e o header ficam só em `mistic.json` na pasta de dados da conta e nunca voltam para o painel.

**Botão flutuante (solto na tela do computador):** no Windows, o programa cria um botão (só o **ícone do bot**, com um selo amarelo quando há cobranças aguardando; o nome do cliente aparece apenas na dica ao passar o mouse) **por cima de qualquer janela** — fora do navegador — que você arrasta para perto da conversa (WhatsApp Web, WhatsApp Desktop...) e que lembra a posição. Ele aparece e some sozinho durante as conversas no privado (ou fica sempre, se preferir), não rouba o foco de onde você está digitando e mostra quantas cobranças estão aguardando pagamento. O WhatsApp não avisa qual conversa está aberta, então "em conversa" significa que houve mensagem — do cliente ou sua — nos últimos 30 minutos (ajustável). Ao clicar, abre uma janelinha (Chrome, Edge ou Brave em modo aplicativo, sem barra de endereço) ao lado do botão com o modal da MisticPay; clicar de novo só traz a janela para a frente. Em Configurações › MisticPay dá para trocar para "dentro da página do painel" (é também o plano B se o botão nativo não conseguir iniciar). O modal tem:

- **Cobrar:** o cliente da conversa já vem selecionado (ou digite outro número, que é conferido no WhatsApp). O bot manda a mensagem da cobrança, o PIX copia e cola sozinho numa mensagem (fácil de copiar) e o QR Code. A **MisticPay exige um CPF do pagador em toda cobrança** (o PIX em si não pede, mas o gateway recusa sem ele: "Um ou mais campos obrigatórios da transação não foram enviados"). Para não precisar pedir o CPF do cliente, salve um **CPF padrão** (em Configurar MisticPay ou, na própria janela de cobrança, digitando o CPF uma vez e marcando "Usar este CPF em todas as cobranças"): a partir daí o campo pode ficar em branco. Digitar outro CPF na cobrança vale só para aquela cobrança.
- **Copiar cobrança (para atender em outro WhatsApp):** ao lado de "Enviar cobrança" há o botão **Copiar cobrança**: ele cria a cobrança na MisticPay **sem mandar nada pelo WhatsApp do bot** e copia o texto (mensagem + PIX copia e cola) para você colar onde atende. O modelo desse texto é configurável em Configurar MisticPay (aceita `{pix}`; sem ele, o código vai no final).
- **Cliente aleatório:** no campo Cliente, escolha **🎲 Cliente aleatório (sem WhatsApp)** quando não tem o número do cliente aqui. O painel sorteia um nome (botão "Sortear outro" para trocar) e preenche a descrição padrão (**Corrida**, configurável); nesse modo só dá para copiar. O CPF continua vindo do CPF padrão salvo: o sistema nunca inventa CPF. O pagamento é acompanhado e avisado normalmente (painel e Windows); só não há agradecimento por WhatsApp, porque não há para quem enviar.
- **Excluir cobrança:** cada cobrança na lista tem o botão **Excluir** (com confirmação). Ela sai do histórico e o sistema para de acompanhá-la. Atenção: a MisticPay não permite cancelar um PIX, então, se o cliente ainda pagar uma cobrança excluída, o dinheiro cai na sua conta mas você não será avisado. Saques não podem ser excluídos por aqui.
- **Saldo sempre em dia:** com o modal aberto, o saldo disponível/bloqueado se atualiza sozinho (a cada ~10 s e logo depois de um pagamento ou saque concluído); o botão de atualizar continua lá para forçar.
- **Pagamento identificado:** o sistema consulta a MisticPay a cada poucos segundos (o webhook não funciona num computador local), avisa no painel e no Windows e manda a mensagem de agradecimento. As consultas respeitam o limite de 60/min da MisticPay e continuam depois de reiniciar o programa.
- **Sacar:** por chave PIX (CPF, CNPJ, e-mail, telefone ou aleatória), com confirmação e trava contra saque duplicado. Exige a **senha de saque** (veja abaixo) — sem ela, nenhum saque sai, mesmo com o painel aberto.
- **Cobranças** (histórico com "Verificar", "Reenviar" e "Copiar PIX") e **Extrato** da conta MisticPay, além do saldo disponível/bloqueado e dos dados da conta.

Todas as mensagens ao cliente (cobrança, legenda do QR Code e agradecimento) são configuráveis, com os marcadores `{valor}`, `{nome}`, `{descricao}` e `{numero}`; o envio do QR Code e do agradecimento pode ser desligado.

### Senha de saque

Todo saque exige uma **senha de saque**, separada de tudo o resto — protege contra saques feitos por quem tiver acesso ao computador (ou ao painel aberto) sem essa senha.

- **Sem senha criada, o saque fica bloqueado.** Crie a primeira em Configurar MisticPay › Senha de saque; não precisa da senha atual pra essa primeira vez.
- Fica guardada só neste computador **como hash** (o mesmo tipo de proteção usada pra senhas de verdade) — nem ela, nem o Client Secret, voltam pra tela do painel.
- **Trocar ou remover** uma senha já existente exige informar a senha atual corretamente — sem isso, quem tivesse acesso ao painel poderia trocar a senha e sacar em seguida, driblando a proteção. Esqueceu a senha? Só reinstalando (apagando o campo `withdrawPasswordHash` de `mistic.json` na pasta de dados da conta) pra criar uma nova.
- **Trava por 5 minutos** depois de 5 tentativas erradas seguidas, mesmo que a próxima seja a senha certa.
- Some da tela assim que o saque é confirmado (ou recusado) — não fica esquecida no campo.

**Métricas preenchidas pelo pagamento:** quando um pagamento é confirmado, a corrida mais recente daquela pessoa nas **Métricas** (gatilho nos últimos 2 dias, anterior à cobrança) vira **Fechou** e recebe o valor recebido, com o selo "Pago · MisticPay" na linha. Se você já tinha fechado a corrida e digitado um valor, o seu valor fica. Quem nunca disparou um gatilho (chegou direto no privado, ou é "cliente aleatório") não muda nenhuma corrida, mas o pagamento entra no cartão **Recebido hoje** (com o total do mês), que conta todos os pagamentos confirmados. A aba Métricas se atualiza sozinha (a cada ~5 s e na hora em que um pagamento cai), refazendo só as linhas que mudaram, sem atrapalhar o que você está editando. Pagamentos confirmados antes desta versão não são preenchidos retroativamente.

Como o painel agora move dinheiro, ele só aceita pedidos feitos por ele mesmo (`Host`/`Origin` verificados): outros sites abertos no navegador não conseguem acionar cobranças nem saques.

## Assistente de corrida (Uber)

Com o assistente ligado (Conversas › Configurações › Assistente de corrida), mandar o link de uma viagem da Uber (`trip.uber.com/...`) numa conversa privada — pelo painel ou direto do celular — faz o bot acompanhar a corrida e avisar o cliente sozinho: motorista a 2 min, a 1 min, chegou e corrida iniciada. Os avisos de "2 min" e "chegou" levam o carro, a placa e o nome do motorista.

- **Só o aviso atual:** se a Uber pular etapas (por exemplo, só der para identificar quando o motorista já chegou), sai apenas o aviso da situação atual — os de "2 min" e "1 min" não são mandados atrasados, todos de uma vez. A cobrança configurada para uma etapa pulada sai mesmo assim, logo depois do aviso.
- **Valor combinado:** vem do último "NN,NN chama ?" que você mandou nessa conversa nas últimas 6 horas. Sem isso, o painel pergunta o valor. Pelo celular, a corrida é acompanhada e o cliente é avisado, mas **sem cobrar**: você recebe um aviso no seu próprio WhatsApp e pode informar o valor pelo botão **Definir valor** na faixa da corrida.
- **Cobrança automática** (opcional, via MisticPay) no momento escolhido: ao mandar o link, a 2 min, a 1 min ou na chegada. Se a cobrança falhar, você recebe um aviso no seu próprio WhatsApp.
- **Mensagens editáveis:** os textos de cada aviso (2 min, 1 min, chegou, corrida iniciada, troca de motorista) são configuráveis, com botão para restaurar o padrão, e dá para desligar a linha com carro/placa/motorista.
- **Faixa na conversa:** enquanto uma corrida é acompanhada, o topo da conversa mostra a situação (tempo até o motorista, carro, placa, valor combinado) e o botão **Parar**.
- **Corridas em andamento:** acima da lista de conversas aparece um quadro com todas as corridas sendo acompanhadas na conta; clicar numa abre a conversa.
- **Sobrevive a reinício:** as corridas em andamento ficam guardadas (`uber-trips.json` na pasta de dados da conta). Ao abrir o programa de novo, assim que o WhatsApp conecta, cada corrida é retomada de onde parou, sem repetir aviso nem cobrança.
- **Motorista trocou:** se a placa mudar antes do embarque, o cliente é avisado da troca e os avisos de chegada voltam a valer para o carro novo (a cobrança não sai de novo).
- **Corrida cancelada:** se a viagem sumir do link antes do embarque, o acompanhamento para e você é avisado. Mandar um link novo na mesma conversa passa a acompanhar a corrida nova — sem cobrar de novo se a anterior já tinha sido cobrada e não embarcou (você é avisado disso também).
- Não é uma integração oficial da Uber: usa o link público de compartilhar viagem e pode parar de funcionar se a Uber mudar o site. Se o bot não conseguir acompanhar, ele avisa no seu próprio WhatsApp.

## Som de mensagem nova

O bip do painel (Configurações › som de notificação) toca só quando chega uma mensagem nova de alguém numa conversa não arquivada. Atualizações de mensagens antigas (mídia que terminou de baixar, status de entrega, mensagem apagada, histórico reentregue ao reconectar) não tocam, e várias mensagens ao mesmo tempo tocam um bip só.

## Testes

```bash
bun run test
bun run typecheck
```
