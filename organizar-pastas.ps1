# Separa o projeto em duas pastas:
#   app\       -> o que vira o exe (o bot + painel)
#   servidor\  -> o que vai para a sua hospedagem (controle de licencas) - ja existe
#
# Rode UMA vez, com o bot fechado:   powershell -ExecutionPolicy Bypass -File organizar-pastas.ps1
# (-IgnorarBotAberto pula a checagem de bot aberto; so use se tiver certeza.)
param([switch]$IgnorarBotAberto)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$app = Join-Path $root "app"

if (Test-Path $app) {
  Write-Host "A pasta app\ ja existe: o projeto ja esta organizado. Nada a fazer."
  exit 0
}

if (-not $IgnorarBotAberto) {
  $running = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "bun.exe" -and $_.CommandLine -match "src[\\/]index\.ts") -or
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))
  }
  if ($running) {
    Write-Host "O bot esta aberto (processo $($running.ProcessId -join ', ')). Feche o programa e rode este script de novo." -ForegroundColor Yellow
    exit 1
  }
}

$items = @("src", "scripts", "assets", "dist", "node_modules", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "README.md")

New-Item -ItemType Directory -Path $app | Out-Null
foreach ($item in $items) {
  $from = Join-Path $root $item
  if (Test-Path $from) {
    Move-Item -LiteralPath $from -Destination (Join-Path $app $item)
    Write-Host "  movido: $item -> app\$item"
  }
}

# O teste de ponta a ponta do app usa o servidor de licencas de verdade: a pasta dele ficou um nivel acima
$test = Join-Path $app "src\core\remote-auth-service.test.ts"
if (Test-Path $test) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $text = [IO.File]::ReadAllText($test, $utf8).Replace('"../../servidor/src/', '"../../../servidor/src/')
  [IO.File]::WriteAllText($test, $text, $utf8)
}

Write-Host ""
Write-Host "Pronto. Daqui pra frente:" -ForegroundColor Green
Write-Host "  cd app       e depois   bun start   (rodar)   |   bun run build   (gerar o exe)"
Write-Host "  cd servidor  e depois   bun start   (servidor de licencas)"
Write-Host "Leia o LEIA-ME.md na raiz para o passo a passo."
