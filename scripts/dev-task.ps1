param(
    [ValidateSet('Install', 'Frontend', 'Backend', 'Build', 'DevLocal', 'Stop', 'Publish', 'CloudflareLogin', 'CloudflareSetup', 'BotInstall', 'BotStart', 'BotStop', 'Doctor', 'Check', 'PhonePair', 'PhoneSetup')]
    [string]$Task = 'DevLocal'
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = (Join-Path $projectDir 'app/.venv/Scripts') + ';' + $machinePath + ';' + $userPath + ';' + $env:PATH
$portableNode = Join-Path (Split-Path -Parent $projectDir) '.tools/node-v24.19.0-win-x64'
if (Test-Path (Join-Path $portableNode 'node.exe')) {
    $env:PATH = $portableNode + ';' + $env:PATH
} elseif (Test-Path 'C:/Program Files/nodejs/node.exe') {
    $env:PATH = 'C:/Program Files/nodejs;' + $env:PATH
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js is missing. Install Node.js 22.12 or later.'
}
Set-Location (Join-Path $projectDir 'app')
switch ($Task) {
    'Install' { & npm.cmd ci }
    'Frontend' { & npm.cmd run dev }
    'Backend' { & npm.cmd run dev:server }
    'Build' { & npm.cmd run build }
    'DevLocal' { & npm.cmd run dev:local }
    'Publish' { & node.exe scripts/publish-main.mjs }
    'CloudflareLogin' { & node.exe node_modules/wrangler/bin/wrangler.js login }
    'CloudflareSetup' { & node.exe scripts/setup-worker.mjs }
    'Doctor' { & node.exe scripts/doctor.mjs }
    'Check' { & npm.cmd run check }
    'PhonePair' {
        & node.exe scripts/pair-phone.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Start-Process -FilePath (Resolve-Path '.local/codex-phone-pairing.html').Path
    }
    'PhoneSetup' {
        $mk8CodexCli = Join-Path (Split-Path -Parent $projectDir) '.tools/codex/node_modules/@openai/codex/bin/codex.js'
        if (-not (Test-Path $mk8CodexCli)) { throw 'The packaged Codex CLI is missing from .tools/codex.' }
        & node.exe $mk8CodexCli app $projectDir
    }
    'BotInstall' {
        $pythonExe = Join-Path $env:LOCALAPPDATA 'Programs/Python/Python312/python.exe'
        if (-not (Test-Path $pythonExe)) { throw 'Install Python 3.12 first.' }
        if (-not (Test-Path '.venv/Scripts/python.exe')) {
            & $pythonExe -m venv .venv
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        & ./.venv/Scripts/python.exe -m pip install -r telegram-bot/requirements-dev.txt
    }
    'BotStart' {
        if (-not (Test-Path '.venv/Scripts/python.exe')) { throw 'Run MK8: Install Telegram bot dependencies first.' }
        & node.exe scripts/ensure-database.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if (Test-Path '.local/bot.pid') {
            $botProcessId = [int](Get-Content '.local/bot.pid')
            $existingBot = Get-CimInstance Win32_Process -Filter "ProcessId = $botProcessId"
            if ($existingBot -and $existingBot.CommandLine -match 'telegram-bot[/\\]bot\.py') {
                Write-Output 'MK8 Telegram bot is already running.'
                exit 0
            }
        }
        $botProcess = Start-Process -FilePath (Resolve-Path '.venv/Scripts/python.exe').Path -ArgumentList '-u', 'telegram-bot/bot.py' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput '.local/bot.log' -RedirectStandardError '.local/bot-error.log' -PassThru
        $botProcess.Id | Set-Content '.local/bot.pid'
        Write-Output ('MK8 Telegram bot started. Process: ' + $botProcess.Id)
        exit 0
    }
    'BotStop' {
        if (-not (Test-Path '.local/bot.pid')) { Write-Output 'No bot process recorded.'; exit 0 }
        $botProcessId = [int](Get-Content '.local/bot.pid')
        $botProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $botProcessId"
        if (-not $botProcess) { Write-Output 'Bot already stopped.'; exit 0 }
        if ($botProcess.CommandLine -notmatch 'telegram-bot[/\\]bot\.py') { throw 'Recorded process is not the Telegram bot; refusing to stop it.' }
        & taskkill.exe /PID $botProcessId /T /F
    }
    'Stop' {
        $pidFile = Join-Path $projectDir 'app/.local/dev.pid'
        if (-not (Test-Path $pidFile)) { Write-Output 'No background MK8 process recorded.'; exit 0 }
        $devProcessId = [int](Get-Content $pidFile)
        $devProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $devProcessId"
        if (-not $devProcess) { Write-Output 'MK8 background process has already stopped.'; exit 0 }
        if ($devProcess.CommandLine -notmatch 'scripts[/\\]dev-local\.mjs') {
            throw 'The recorded process is no longer MK8; refusing to stop it.'
        }
        & taskkill.exe /PID $devProcessId /T /F
    }
}
exit $LASTEXITCODE
