<#
  Removes the DiGiCo Aux Bridge service and its firewall rules. Leaves the folder and config.json alone.
      powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Continue'
$Svc = Join-Path $PSScriptRoot 'DigicoAuxBridge-service.exe'

if (Get-Service -Name 'DigicoAuxBridge' -ErrorAction SilentlyContinue) {
  if (Test-Path $Svc) { & $Svc stop; Start-Sleep -Seconds 1; & $Svc uninstall }
  else { Stop-Service DigicoAuxBridge -Force; sc.exe delete DigicoAuxBridge | Out-Null }
  Write-Host "Service removed."
} else { Write-Host "Service was not installed." }

Get-NetFirewallRule -Group 'DiGiCo Aux Bridge' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Firewall rules removed."
