param(
  [int]$OldPid = 0,
  [string]$ProjectDir = "",
  [string]$TelegramToken = "",
  [string]$TelegramChatId = ""
)

$logFile = Join-Path ([System.IO.Path]::GetTempPath()) "capri_restart.log"
"[" + (Get-Date).ToString("o") + "] Capri Restart Launcher started. OldPid=$OldPid" | Out-File $logFile -Append

# Step 1: Wait briefly so Telegram HTTP response finishes sending
Start-Sleep -Milliseconds 1500

# Step 2: Stop old Capri/Electron process safely
if ($OldPid -gt 0) {
  try {
    Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
    "[" + (Get-Date).ToString("o") + "] Terminated old process $OldPid" | Out-File $logFile -Append
  } catch {}
}

# Clean any dangling Electron processes from this project
try {
  $myPid = $PID
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -match 'electron') -and 
    ($_.CommandLine -match 'capri-desktop') -and 
    ($_.ProcessId -ne $myPid)
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
} catch {}

# Step 3: Wait for ports (47823) and locks to release
Start-Sleep -Milliseconds 2000

# Step 4: Resolve exact project root (where package.json lives)
if (-not $ProjectDir -or -not (Test-Path (Join-Path $ProjectDir "package.json"))) {
  $curr = (Get-Item $PSScriptRoot).FullName
  while ($curr -and -not (Test-Path (Join-Path $curr "package.json"))) {
    $parent = (Get-Item $curr).Parent
    if (-not $parent) { break }
    $curr = $parent.FullName
  }
  if (Test-Path (Join-Path $curr "package.json")) {
    $ProjectDir = $curr
  } else {
    $ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName
  }
}

"[" + (Get-Date).ToString("o") + "] Starting npm run dev in $ProjectDir" | Out-File $logFile -Append

# Clean ELECTRON_RUN_AS_NODE so Electron runs as interactive GUI
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "Process")

# Launch npm run dev in a new interactive PowerShell terminal window
try {
  $p = Start-Process powershell.exe -WorkingDirectory $ProjectDir -ArgumentList "-NoExit", "-Command", "npm run dev" -PassThru
  "[" + (Get-Date).ToString("o") + "] New terminal process spawned with PID=" + $p.Id | Out-File $logFile -Append
} catch {
  "[" + (Get-Date).ToString("o") + "] Failed to start process: $_" | Out-File $logFile -Append
}

# Step 5: Send Telegram confirmation
if ($TelegramToken -and $TelegramChatId) {
  Start-Sleep -Seconds 4
  try {
    $body = @{
      chat_id = $TelegramChatId
      text = "⚡ *Capri Başarıyla Yeniden Başlatıldı!*`n`n`npm run dev` yeni terminal oturumunda devrede. Choom, emrindeyim!"
      parse_mode = "Markdown"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramToken/sendMessage" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 10 -ErrorAction SilentlyContinue
  } catch {}
}
