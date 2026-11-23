<#
  Installs DiGiCo Aux Bridge as a Windows service that starts at boot and restarts if it crashes.
  Run from an elevated PowerShell in the folder that holds DigicoAuxBridge.exe:

      powershell -ExecutionPolicy Bypass -File .\install.ps1
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -DisableSleep

  -DisableSleep  also stops this PC from sleeping/hibernating while on AC power.
  Re-running the script is safe: it reinstalls the service and refreshes firewall rules
  (do this after changing ports in config.json).
#>
#Requires -RunAsAdministrator
param([switch]$DisableSleep)

$ErrorActionPreference = 'Stop'
$Dir      = $PSScriptRoot
$Exe      = Join-Path $Dir 'DigicoAuxBridge.exe'
$Svc      = Join-Path $Dir 'DigicoAuxBridge-service.exe'   # WinSW, renamed to match its XML
$Xml      = Join-Path $Dir 'DigicoAuxBridge-service.xml'
$Config   = Join-Path $Dir 'config.json'
$RuleGroup = 'DiGiCo Aux Bridge'
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

if (-not (Test-Path $Exe)) { throw "DigicoAuxBridge.exe not found in $Dir" }
if (-not (Test-Path $Config)) { throw "config.json not found in $Dir" }
$cfg = Get-Content $Config -Raw | ConvertFrom-Json

# --- WinSW (service wrapper) ---
if (-not (Test-Path $Svc)) {
  $local = Join-Path $Dir 'WinSW-x64.exe'
  if (Test-Path $local) { Copy-Item $local $Svc }
  else {
    Write-Host "Downloading WinSW service wrapper..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $Svc -UseBasicParsing
  }
}

@"
<service>
  <id>DigicoAuxBridge</id>
  <name>DiGiCo Aux Bridge</name>
  <description>OSC bridge between a DiGiCo console, the DiGiCo iPad app and the web aux mixer.</description>
  <executable>%BASE%\DigicoAuxBridge.exe</executable>
  <workingdirectory>%BASE%</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="3 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>%BASE%\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>5120</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@ | Set-Content -Path $Xml -Encoding UTF8

# --- (re)install service ---
$existing = Get-Service -Name 'DigicoAuxBridge' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing previous service..."
  & $Svc stop | Out-Null
  Start-Sleep -Seconds 1
  & $Svc uninstall | Out-Null
  Start-Sleep -Seconds 1
}
& $Svc install
if ($LASTEXITCODE -ne 0) { throw "Service install failed" }

# --- firewall ---
Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$udp = @([int]$cfg.console.sendPort)
if ($cfg.ipad.enabled) { $udp += [int]$cfg.ipad.sendPort }
New-NetFirewallRule -DisplayName "$RuleGroup - OSC (UDP $($udp -join ','))" -Group $RuleGroup `
  -Direction Inbound -Protocol UDP -LocalPort $udp -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "$RuleGroup - Web (TCP $($cfg.web.port))" -Group $RuleGroup `
  -Direction Inbound -Protocol TCP -LocalPort ([int]$cfg.web.port) -Action Allow -Profile Any | Out-Null
Write-Host "Firewall: allowed UDP $($udp -join ', ') and TCP $($cfg.web.port) inbound."

# --- power ---
if ($DisableSleep) {
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  Write-Host "Power: sleep and hibernate disabled on AC power."
} else {
  Write-Host "Tip: re-run with -DisableSleep, or set Sleep to 'Never' yourself. A sleeping PC drops the bridge."
}

& $Svc start
Start-Sleep -Seconds 2
$s = Get-Service -Name 'DigicoAuxBridge'
Write-Host ""
Write-Host "Service status: $($s.Status)"
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) { Write-Host "Mixer page:  http://${ip}:$($cfg.web.port)/" }
Write-Host "Status page: http://localhost:$($cfg.web.port)/status"
Write-Host "Logs:        $Dir\logs"
Write-Host ""
Write-Host "Also check: Device Manager > network adapter > Power Management > untick 'Allow the computer to turn off this device'."
