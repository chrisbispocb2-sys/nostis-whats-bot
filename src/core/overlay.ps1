# Botao flutuante da MisticPay (Windows). Iniciado pelo BotBrinzy.exe - nao precisa rodar na mao.
#
# - Janela sem borda, sempre no topo, que NAO rouba o foco do WhatsApp quando aparece.
# - Aparece e some sozinha conforme o servidor (GET /overlay/state) diz que ha uma conversa ativa.
# - Arrastavel; lembra a posicao em $PosFile.
# - Clique: traz a janela de pagamento pra frente ou pede ao servidor pra abrir uma (POST /overlay/open)
#   e a coloca ao lado do botao.
# - Se o BotBrinzy.exe fechar (ou o servidor sumir), o botao se encerra sozinho.
#
# Este arquivo e so ASCII de proposito (o PowerShell 5.1 le arquivos sem BOM como ANSI).

param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$PosFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

$base = "http://127.0.0.1:$Port"
$PAY_TITLE_PREFIX = 'Brinzy MisticPay'
$POLL_MS = 1500
$MAX_FAILURES = 20

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class BrinzyWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

  public static IntPtr FindByTitlePrefix(string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().StartsWith(prefix, StringComparison.Ordinal)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Move e redimensiona sem mudar a ordem das janelas (SWP_NOZORDER)
  public static void Place(IntPtr h, int x, int y, int w, int height) {
    if (IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, IntPtr.Zero, x, y, w, height, 0x0004);
  }

  // Traz pra frente sem prender a janela no topo: vira "sempre no topo" e volta ao normal
  public static void Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    SetForegroundWindow(h);
  }
}
"@

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="BrinzyOverlay" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False" ResizeMode="NoResize"
        SizeToContent="WidthAndHeight" Visibility="Hidden" UseLayoutRounding="True">
  <Grid Margin="14">
    <!-- So o icone do bot (o mesmo logo do painel): quadrado arredondado roxo com o robo em branco -->
    <Border Name="Pill" Width="56" Height="56" CornerRadius="17" Cursor="Hand">
      <Border.Background>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
          <GradientStop Color="#9061F9" Offset="0"/>
          <GradientStop Color="#6D28D9" Offset="1"/>
        </LinearGradientBrush>
      </Border.Background>
      <Border.Effect>
        <DropShadowEffect BlurRadius="22" ShadowDepth="5" Opacity="0.6" Color="#4C1D95"/>
      </Border.Effect>
      <Viewbox Width="32" Height="32" HorizontalAlignment="Center" VerticalAlignment="Center" IsHitTestVisible="False">
        <Canvas Width="24" Height="24">
          <Path Data="M12,8 L12,4 L8,4" Stroke="White" StrokeThickness="2"
                StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/>
          <Rectangle Canvas.Left="4" Canvas.Top="8" Width="16" Height="12" RadiusX="2" RadiusY="2"
                     Stroke="White" StrokeThickness="2"/>
          <Path Data="M2,14 L4,14 M20,14 L22,14 M15,13 L15,15 M9,13 L9,15" Stroke="White" StrokeThickness="2"
                StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
        </Canvas>
      </Viewbox>
    </Border>
    <!-- Quantas cobrancas aguardam pagamento (so aparece quando ha alguma) -->
    <Border Name="Badge" Visibility="Collapsed" Background="#FBBF24" BorderBrush="#1E1B2E" BorderThickness="2"
            CornerRadius="11" MinWidth="22" Height="22" Padding="5,0"
            HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,-8,-8,0" IsHitTestVisible="False">
      <TextBlock Name="BadgeText" Text="0" Foreground="#1C1200" FontWeight="Bold" FontSize="11"
                 FontFamily="Segoe UI" HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Border>
  </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$pill = $window.FindName('Pill')
$badge = $window.FindName('Badge')
$badgeText = $window.FindName('BadgeText')

$http = New-Object System.Net.WebClient
$http.Encoding = [System.Text.Encoding]::UTF8
$http.Proxy = $null
$script:failures = 0
$script:state = $null

function Write-Log([string]$message) {
  [Console]::Error.WriteLine("[overlay] $message")
}

# ---------- Posicao ----------

function Set-Position([double]$left, [double]$top) {
  $vl = [Windows.SystemParameters]::VirtualScreenLeft
  $vt = [Windows.SystemParameters]::VirtualScreenTop
  $vw = [Windows.SystemParameters]::VirtualScreenWidth
  $vh = [Windows.SystemParameters]::VirtualScreenHeight
  $w = if ($window.ActualWidth -gt 0) { $window.ActualWidth } else { 84 }
  $h = if ($window.ActualHeight -gt 0) { $window.ActualHeight } else { 84 }
  $window.Left = [Math]::Min([Math]::Max($vl, $left), $vl + $vw - $w)
  $window.Top = [Math]::Min([Math]::Max($vt, $top), $vt + $vh - $h)
}

function Save-Position {
  try {
    $dir = Split-Path -Parent $PosFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    (@{ left = $window.Left; top = $window.Top } | ConvertTo-Json) | Set-Content -Path $PosFile -Encoding UTF8
  } catch { Write-Log "nao foi possivel salvar a posicao: $_" }
}

function Restore-Position {
  $wa = [Windows.SystemParameters]::WorkArea
  $left = $wa.Right - 120
  $top = $wa.Bottom - 190
  try {
    if (Test-Path $PosFile) {
      $saved = Get-Content -Raw -Path $PosFile | ConvertFrom-Json
      if ($null -ne $saved.left -and $null -ne $saved.top) { $left = [double]$saved.left; $top = [double]$saved.top }
    }
  } catch { Write-Log "posicao salva ilegivel, usando a padrao: $_" }
  Set-Position $left $top
}

# ---------- Onde abrir a janela de pagamento ----------

function Get-PillRect {
  $origin = $pill.PointToScreen((New-Object System.Windows.Point 0, 0))
  $m = [Windows.PresentationSource]::FromVisual($window).CompositionTarget.TransformToDevice
  return @{
    X = [int]$origin.X; Y = [int]$origin.Y
    W = [int]($pill.ActualWidth * $m.M11); H = [int]($pill.ActualHeight * $m.M22)
  }
}

# Ao lado do botao (pro lado com mais espaco), com o rodape alinhado ao dele, sempre dentro da tela
function Get-PayWindowRect {
  $r = Get-PillRect
  $center = [System.Drawing.Point]::new($r.X + [int]($r.W / 2), $r.Y + [int]($r.H / 2))
  $wa = [System.Windows.Forms.Screen]::FromPoint($center).WorkingArea
  $w = [Math]::Min(500, $wa.Width - 20)
  $h = [Math]::Min(780, $wa.Height - 20)
  $gap = 12
  if ($center.X -gt ($wa.Left + $wa.Width / 2)) { $x = $r.X - $w - $gap } else { $x = $r.X + $r.W + $gap }
  $y = $r.Y + $r.H - $h
  $x = [Math]::Min([Math]::Max($wa.Left + 10, $x), $wa.Right - $w - 10)
  $y = [Math]::Min([Math]::Max($wa.Top + 10, $y), $wa.Bottom - $h - 10)
  return @{ X = [int]$x; Y = [int]$y; W = [int]$w; H = [int]$h }
}

function Open-PayWindow {
  $s = $script:state
  if ($null -eq $s -or -not $s.visible) { return }

  # Ja aberta? So traz pra frente
  $existing = [BrinzyWin]::FindByTitlePrefix($PAY_TITLE_PREFIX)
  if ($existing -ne [IntPtr]::Zero) { [BrinzyWin]::Raise($existing); return }

  $rect = Get-PayWindowRect
  $body = @{ accountId = $s.accountId; x = $rect.X; y = $rect.Y; width = $rect.W; height = $rect.H } | ConvertTo-Json
  try {
    $http.Headers.Set('Content-Type', 'application/json')
    [void]$http.UploadString("$base/overlay/open", 'POST', $body)
  } catch { Write-Log "nao foi possivel abrir a janela de pagamento: $_"; return }

  # Espera a janela aparecer e a coloca no lugar (garante a posicao mesmo com escala de tela diferente)
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 150
    $hwnd = [BrinzyWin]::FindByTitlePrefix($PAY_TITLE_PREFIX)
    if ($hwnd -ne [IntPtr]::Zero) {
      [BrinzyWin]::Place($hwnd, $rect.X, $rect.Y, $rect.W, $rect.H)
      [BrinzyWin]::Raise($hwnd)
      return
    }
  }
}

# ---------- Estado vindo do servidor ----------

function Update-State {
  try {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $window.Close(); return }

    $s = $http.DownloadString("$base/overlay/state") | ConvertFrom-Json
    $script:failures = 0
    $script:state = $s

    if ($s.visible) {
      $pill.ToolTip = [string]$s.tooltip
      if ([int]$s.pending -gt 0) { $badgeText.Text = [string]$s.pending; $badge.Visibility = 'Visible' } else { $badge.Visibility = 'Collapsed' }
      if ($window.Visibility -ne 'Visible') { $window.Visibility = 'Visible' }
    } elseif ($window.Visibility -ne 'Hidden') {
      $window.Visibility = 'Hidden'
    }
  } catch {
    $script:failures++
    if ($script:failures -ge $MAX_FAILURES) { Write-Log 'servidor nao responde, encerrando'; $window.Close() }
  }
}

# ---------- Mouse: arrastar ou clicar ----------

# Arrasto manual (em vez do DragMove do Windows): captura o mouse, so vira "arrasto" depois de andar alguns
# pixels; se o botao for solto sem andar, e um clique. Assim clique e arrasto nunca se confundem.
$DRAG_THRESHOLD_PX = 5
$script:drag = $null

function Get-MouseScreenPoint($e) {
  return $pill.PointToScreen($e.GetPosition($pill))
}

$pill.Add_MouseLeftButtonDown({
  param($sender, $e)
  try {
    $p = Get-MouseScreenPoint $e
    $script:drag = @{ StartX = $p.X; StartY = $p.Y; Left = $window.Left; Top = $window.Top; Moved = $false }
    [void]$pill.CaptureMouse()
    $e.Handled = $true
  } catch { Write-Log "erro ao segurar o botao: $_" }
})

$pill.Add_MouseMove({
  param($sender, $e)
  if ($null -eq $script:drag) { return }
  try {
    $p = Get-MouseScreenPoint $e
    $dx = $p.X - $script:drag.StartX
    $dy = $p.Y - $script:drag.StartY
    if (-not $script:drag.Moved -and ([Math]::Abs($dx) + [Math]::Abs($dy)) -lt $DRAG_THRESHOLD_PX) { return }
    $script:drag.Moved = $true
    $m = [Windows.PresentationSource]::FromVisual($window).CompositionTarget.TransformToDevice
    Set-Position ($script:drag.Left + $dx / $m.M11) ($script:drag.Top + $dy / $m.M22)
  } catch { Write-Log "erro ao arrastar: $_" }
})

$pill.Add_MouseLeftButtonUp({
  param($sender, $e)
  if ($null -eq $script:drag) { return }
  $d = $script:drag
  $script:drag = $null
  try {
    $pill.ReleaseMouseCapture()
    Write-Log "mouse: $(if ($d.Moved) { 'arrasto' } else { 'clique' })"
    if ($d.Moved) { Save-Position } else { Open-PayWindow }
  } catch { Write-Log "erro no clique: $_" }
})

$window.Add_Closed({ [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })
[Windows.Threading.Dispatcher]::CurrentDispatcher.add_UnhandledException({ param($sender, $e) Write-Log "erro: $($e.Exception.Message)"; $e.Handled = $true })

Restore-Position
Update-State

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($POLL_MS)
$timer.Add_Tick({ Update-State })
$timer.Start()

Write-Log 'pronto'
[Windows.Threading.Dispatcher]::Run()
