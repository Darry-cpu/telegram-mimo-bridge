# Watchdog for the Telegram-MiMo bridge.
# Ensures exactly one bridge runs; restarts it if it dies or its heartbeat goes stale.
$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $root "watchdog.log"
$heartbeatPath = Join-Path $root "heartbeat.txt"
$bridgePath = Join-Path $root "bridge.js"
$bridgeLogPath = Join-Path $root "bridge.log"

# Only one watchdog may run (named mutex is atomic, unlike a lock file).
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\TelegramMiMoBridgeWatchdog", [ref]$createdNew)
if (-not $createdNew) {
    Write-Host "another watchdog is already running, exiting"
    exit 0
}

function WLog($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Find-Node {
    # Prefer a standalone Node: the MiMo-bundled node.exe is a shim that spawns
    # a second runtime process, which makes one logical bridge look like two.
    $sys = "C:\Program Files\nodejs\node.exe"
    if (Test-Path $sys) { return $sys }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bundled = Join-Path $env:APPDATA "Xiaomi MiMo\runtimes\bundled\52714f768b8b\node\node.exe"
    if (Test-Path $bundled) { return $bundled }
    return $null
}

$node = Find-Node
if (-not $node) {
    WLog "Node.js not found. Please install Node.js first."
    exit 1
}

$env:NODE_USE_ENV_PROXY = "1"
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = "http://127.0.0.1:7890" }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = "http://127.0.0.1:7890" }

WLog "watchdog started, node=$node"

# Any process actually running our bridge file (node shim or MiMo runtime host).
function Get-BridgeProcesses {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*telegram-mimo-bridge*bridge.js*" -and
            $_.Name -ne "powershell.exe" -and
            $_.Name -ne "pwsh.exe"
        }
}

function Get-HeartbeatAgeMinutes {
    if (-not (Test-Path $heartbeatPath)) { return 999 }
    $raw = Get-Content $heartbeatPath -First 1
    $ticks = 0L
    if (-not [long]::TryParse($raw, [ref]$ticks)) { return 999 }
    $stamp = [DateTimeOffset]::FromUnixTimeMilliseconds($ticks).LocalDateTime
    $age = (Get-Date) - $stamp
    return [math]::Round($age.TotalMinutes, 1)
}

# A bridge that is merely failing to reach the network keeps writing to its log,
# so log freshness tells "busy retrying" apart from "really stuck".
function Get-LogAgeMinutes {
    if (-not (Test-Path $bridgeLogPath)) { return 999 }
    $age = (Get-Date) - (Get-Item $bridgeLogPath).LastWriteTime
    return [math]::Round($age.TotalMinutes, 1)
}

function Stop-AllBridges {
    foreach ($p in (Get-BridgeProcesses)) {
        WLog ("stopping pid=" + $p.ProcessId + " name=" + $p.Name)
        Stop-Process -Id $p.ProcessId -Force
    }
    Start-Sleep -Seconds 3
}

function Start-Bridge {
    Start-Process -FilePath $node -ArgumentList ('"' + $bridgePath + '"') -WorkingDirectory $root -WindowStyle Hidden
}

# Restart pacing: repeated restarts back off 1 -> 10 minutes. A bridge that stays
# healthy for 5 minutes clears the penaltly, so a one-off crash still recovers fast.
$restartStreak = 0
$nextRestartAllowedAt = Get-Date

function Register-Restart {
    $script:restartStreak = $script:restartStreak + 1
    $waitMinutes = [math]::Min(10, [math]::Pow(2, $script:restartStreak - 1))
    $script:nextRestartAllowedAt = (Get-Date).AddMinutes($waitMinutes)
    WLog ("restart streak=" + $script:restartStreak + ", next restart allowed after " + $waitMinutes + " min")
}

function Test-RestartAllowed {
    return ((Get-Date) -ge $script:nextRestartAllowedAt)
}

$healthySince = $null

while ($true) {
    $procs = @(Get-BridgeProcesses)

    if ($procs.Count -eq 0) {
        if (Test-RestartAllowed) {
            WLog "bridge not running, starting..."
            Start-Bridge
            Start-Sleep -Seconds 20
            if (@(Get-BridgeProcesses).Count -gt 0) { WLog "bridge started" } else { WLog "start failed, will retry" ; Register-Restart }
        }
        else {
            WLog "bridge down but restart is backing off, waiting"
        }
        $healthySince = $null
    }
    elseif ($procs.Count -gt 1) {
        # Duplicated instances make Telegram reject both ("Conflict: terminated
        # by other getUpdates request"). Clean slate and start one.
        WLog ("found " + $procs.Count + " bridge instances, resetting to a single one")
        Stop-AllBridges
        Start-Bridge
        Start-Sleep -Seconds 20
        $healthySince = $null
    }
    else {
        $heartbeatAge = Get-HeartbeatAgeMinutes
        $logAge = Get-LogAgeMinutes

        if ($heartbeatAge -le 3) {
            # Healthy right now.
            if ($null -eq $healthySince) { $healthySince = Get-Date }
            elseif (((Get-Date) - $healthySince).TotalMinutes -ge 5 -and $restartStreak -gt 0) {
                WLog ("bridge healthy for 5+ min, clearing restart streak (" + $restartStreak + ")")
                $restartStreak = 0
                $nextRestartAllowedAt = Get-Date
            }
        }
        elseif ($heartbeatAge -gt 15 -and $logAge -gt 15) {
            # No heartbeat AND no log activity: the process is genuinely hung.
            if (Test-RestartAllowed) {
                WLog ("bridge hung (heartbeat " + $heartbeatAge + " min, log " + $logAge + " min), restarting")
                Stop-AllBridges
                Start-Bridge
                Start-Sleep -Seconds 20
                Register-Restart
            }
            else {
                WLog ("bridge looks hung but restart is backing off; next attempt later")
            }
            $healthySince = $null
        }
        elseif ($heartbeatAge -gt 15) {
            # Still writing logs: it is retrying a network/proxy problem. Killing it
            # would not help and would restart the retry budget, so leave it alone.
            WLog ("heartbeat " + $heartbeatAge + " min old but bridge is still active (log " + $logAge + " min) - network trouble, not restarting")
            $healthySince = $null
        }
    }

    Start-Sleep -Seconds 60
}
