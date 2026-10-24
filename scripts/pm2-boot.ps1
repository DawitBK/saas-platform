# Registers (or removes) a Windows scheduled task that runs `npm run pm2:start` when the user signs in, so the platform and its
# watchdog come back after a restart without anyone typing a command. Use it through `npm run pm2:boot` / `npm run pm2:unboot`.
# The task is the user's own (no administrator rights, no stored password) and starts 90 seconds after sign-in to give Docker
# Desktop time to come up; the stack job and the watchdog both wait for Docker anyway.
param(
    [Parameter(Mandatory)][ValidateSet('install', 'remove', 'status')][string]$Action,
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$Node
)
$ErrorActionPreference = 'Stop'
$name = 'SaaS-Platform-PM2'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue

switch ($Action) {
    'install' {
        $script = Join-Path $Repo 'scripts\pm2.mjs'
        $run = New-ScheduledTaskAction -Execute $Node -Argument "`"$script`" start" -WorkingDirectory $Repo
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $trigger.Delay = 'PT90S'
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $name -Action $run -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the SaaS platform stack and its pm2 watchdog at sign-in (npm run pm2:start).' -Force | Out-Null
        Write-Host "Scheduled task '$name' installed: runs 'pm2:start' 90 seconds after you sign in."
    }
    'remove' {
        if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Scheduled task '$name' removed." }
        else { Write-Host "Scheduled task '$name' was not installed." }
    }
    'status' {
        if ($existing) { $existing | Get-ScheduledTaskInfo | Format-List TaskName, LastRunTime, LastTaskResult, NextRunTime } else { Write-Host "Scheduled task '$name' is not installed." }
    }
}
