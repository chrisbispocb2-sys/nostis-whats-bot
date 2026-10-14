import { logger } from "../utils/logger";

/**
 * Notificação do Windows (aquele balão no canto da tela). Mostrada por um PowerShell escondido, em
 * vez de um binário nativo em node_modules: aquele daemon abria uma janela preta de console (o
 * programa não tem console próprio, então o Windows criava uma pra ele) e ainda dependia de um .exe
 * que nem sempre ia junto no executável distribuído. Fora do Windows não faz nada (as notificações
 * do app são só no Windows). É sempre o melhor esforço: se falhar, a informação também aparece no painel.
 */

// O título e o corpo vão por variáveis de ambiente (não no comando), pra não ter problema de aspas.
// `$(...)`/`$env:` abaixo é do PowerShell, não interpolação de JS; as contrabarras do AppUserModelID
// vão dobradas só por causa da string de JS (no PowerShell chegam simples).
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $xml.GetElementsByTagName('text')
  [void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:BRINZY_TOAST_TITLE))
  [void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:BRINZY_TOAST_BODY))
  if ($env:BRINZY_TOAST_SILENT -eq '1') {
    $audio = $xml.CreateElement('audio'); $audio.SetAttribute('silent', 'true'); [void]$xml.DocumentElement.AppendChild($audio)
  }
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {}
`;

/** Quem realmente mostra o balão (trocável nos testes). Devolver uma Promise que não rejeita. */
export type ShowToast = (title: string, body: string, silent: boolean) => Promise<void>;

/** PowerShell escondido (sem janela): mostra o balão e pronto. Qualquer erro é engolido — é só um aviso. */
const showToastWithPowerShell: ShowToast = (title, body, silent) => {
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
    env: { ...process.env, BRINZY_TOAST_TITLE: title, BRINZY_TOAST_BODY: body, BRINZY_TOAST_SILENT: silent ? "1" : "0" },
  });
  return proc.exited.then(() => {});
};

export interface NotifierOptions {
  /** Só pra testes: no lugar do PowerShell de verdade. */
  show?: ShowToast;
  /** Só pra testes: finge outro sistema operacional. */
  platform?: string;
}

export class NotificationService {
  constructor(private readonly options: NotifierOptions = {}) {}

  /** `sound: false` mostra o balão sem tocar o som dele. */
  async send(title: string, body: string, { sound = true }: { sound?: boolean } = {}): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "win32") return; // notificações do app são só no Windows
    try {
      await (this.options.show ?? showToastWithPowerShell)(title, body, !sound);
    } catch (err) {
      logger.debug({ err }, "Falha ao mostrar a notificação do Windows (ignorado)");
    }
  }
}

// Uma única instância pro programa todo, criada na primeira notificação.
let shared: NotificationService | null = null;

/** `sound: false` mostra o aviso do Windows sem tocar o som dele. */
export function sendNotification(title: string, body: string, options: { sound?: boolean } = {}): Promise<void> {
  shared ??= new NotificationService();
  return shared.send(title, body, options);
}
