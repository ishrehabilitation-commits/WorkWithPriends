<# : WorkWithPriends setup for Windows. Double-click this file.
@echo off
rem The lines above and below are a batch file that runs the PowerShell part
rem of this same file, so one file can be copied anywhere (a network share,
rem a USB stick) and double-clicked. PowerShell skips this block as a comment.
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -Command "iex ([System.IO.File]::ReadAllText('%~f0'))"
exit /b %errorlevel%
: end of the batch part #>

# What this does, in order:
#   1. Checks Chrome and Edge are closed, and offers to close them.
#   2. Asks where to put the extension, and which Chrome and Edge profiles
#      to open it in.
#   3. Installs Git with winget if it's missing.
#   4. Clones the extension from GitHub, or updates an existing copy.
#   5. Registers the Update now helper (updater\install-windows.ps1).
#   6. Offers to open the browser on the extensions page, walks through
#      loading the extension in a small window beside it, then opens WellSky.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Title = "WorkWithPriends setup"
$RepoUrl = "https://github.com/ishrehabilitation-commits/WorkWithPriends.git"
$ExtensionId = "hkpepagaakilnfcengfoaipokpfaplna"
$WellSkyUrl = "https://woodlake.specialtycare.wellsky.com/Interactant/"
$DefaultFolder = Join-Path $env:USERPROFILE "WorkWithPriends"

$Browsers = @(
  [pscustomobject]@{
    Name = "Google Chrome"; Exe = "chrome.exe"; Process = "chrome"; ExtensionsPage = "chrome://extensions"
    UserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
    Fallbacks = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  },
  [pscustomobject]@{
    Name = "Microsoft Edge"; Exe = "msedge.exe"; Process = "msedge"; ExtensionsPage = "edge://extensions"
    UserData = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"
    Fallbacks = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  }
)

function Show-Message([string]$Text, [string]$Buttons = "OK", [string]$Icon = "Information") {
  return [System.Windows.Forms.MessageBox]::Show($Text, $Title, $Buttons, $Icon)
}

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "== $Text" -ForegroundColor Cyan
}

# Where the browser is installed: the App Paths registry entry first, then
# the usual install folders.
function Find-BrowserExe($Browser) {
  foreach ($root in @("HKLM:", "HKCU:")) {
    $key = "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($Browser.Exe)"
    try {
      $path = (Get-ItemProperty -Path $key -ErrorAction Stop)."(default)"
      if ($path -and (Test-Path $path)) { return $path.Trim('"') }
    } catch { }
  }
  foreach ($path in $Browser.Fallbacks) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  return $null
}

# The browser's profiles, with the names people see, Default first.
function Get-Profiles($Browser) {
  $list = @()
  $localState = Join-Path $Browser.UserData "Local State"
  if (Test-Path $localState) {
    try {
      $cache = ([System.IO.File]::ReadAllText($localState) | ConvertFrom-Json).profile.info_cache
      foreach ($p in $cache.PSObject.Properties) {
        $list += [pscustomobject]@{ Dir = $p.Name; Name = $p.Value.name }
      }
    } catch { }
  }
  if ($list.Count -eq 0 -and (Test-Path $Browser.UserData)) {
    foreach ($d in Get-ChildItem $Browser.UserData -Directory) {
      if ($d.Name -eq "Default" -or $d.Name -like "Profile *") {
        $list += [pscustomobject]@{ Dir = $d.Name; Name = $d.Name }
      }
    }
  }
  if ($list.Count -eq 0) { $list += [pscustomobject]@{ Dir = "Default"; Name = "Default" } }
  return @($list | Sort-Object @{ Expression = { if ($_.Dir -eq "Default") { 0 } else { 1 } } }, Dir)
}

# True when this profile already has the extension loaded.
function Test-ExtensionLoaded($Browser, [string]$ProfileDir) {
  foreach ($file in @("Secure Preferences", "Preferences")) {
    $path = Join-Path (Join-Path $Browser.UserData $ProfileDir) $file
    try {
      if ((Test-Path $path) -and ([System.IO.File]::ReadAllText($path) -match $ExtensionId)) { return $true }
    } catch { }
  }
  return $false
}

function Update-Path {
  # A fresh install changes PATH in the registry, not in this window.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
}

# --- 1. Browsers closed? ---------------------------------------------------
function Confirm-BrowsersClosed {
  $open = @(Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue)
  if ($open.Count -eq 0) { return }
  $names = @($open | ForEach-Object { if ($_.Name -eq "chrome") { "Chrome" } else { "Edge" } } | Sort-Object -Unique) -join " and "
  $answer = Show-Message ("$names is open. Setup works best with it closed.`n`n" +
    "Yes: close it for me. Save any work in open pages first.`n" +
    "No: carry on with it open.`n" +
    "Cancel: stop setup.") "YesNoCancel" "Question"
  if ($answer -eq "Cancel") { exit 0 }
  if ($answer -eq "Yes") {
    foreach ($p in $open) { try { $p.CloseMainWindow() | Out-Null } catch { } }
    Start-Sleep -Seconds 3
    Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}

# --- 2. Choices --------------------------------------------------------------
function Show-SetupForm {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(520, 330)
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Install the extension in this folder:"
  $label.SetBounds(16, 14, 480, 20)
  $form.Controls.Add($label)

  $folderBox = New-Object System.Windows.Forms.TextBox
  $folderBox.Text = $DefaultFolder
  $folderBox.SetBounds(16, 36, 400, 24)
  $form.Controls.Add($folderBox)

  $browse = New-Object System.Windows.Forms.Button
  $browse.Text = "Browse..."
  $browse.SetBounds(424, 35, 80, 26)
  $browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Choose where to put the WorkWithPriends extension. A new WorkWithPriends folder is made inside it."
    if ($dialog.ShowDialog() -eq "OK") { $folderBox.Text = Join-Path $dialog.SelectedPath "WorkWithPriends" }
  })
  $form.Controls.Add($browse)

  $rows = @()
  $top = 76
  foreach ($b in $Browsers) {
    $exe = Find-BrowserExe $b
    $group = New-Object System.Windows.Forms.GroupBox
    $group.Text = $b.Name
    $group.SetBounds(16, $top, 488, 92)
    $form.Controls.Add($group)

    $check = New-Object System.Windows.Forms.CheckBox
    $check.SetBounds(12, 20, 460, 22)
    $group.Controls.Add($check)

    $profileLabel = New-Object System.Windows.Forms.Label
    $profileLabel.Text = "Profile:"
    $profileLabel.SetBounds(30, 54, 50, 20)
    $group.Controls.Add($profileLabel)

    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.DropDownStyle = "DropDownList"
    $combo.SetBounds(84, 51, 388, 24)
    $group.Controls.Add($combo)

    $profiles = @()
    if ($exe) {
      $check.Text = "Use with $($b.Name) ($exe)"
      $check.Checked = ($b.Process -eq "chrome")
      $profiles = Get-Profiles $b
      foreach ($p in $profiles) {
        $text = if ($p.Name -and $p.Name -ne $p.Dir) { "$($p.Name)  ($($p.Dir))" } else { $p.Dir }
        [void]$combo.Items.Add($text)
      }
      $combo.SelectedIndex = 0
    } else {
      $check.Text = "$($b.Name) isn't installed on this computer"
      $check.Enabled = $false
      $combo.Enabled = $false
    }
    $rows += [pscustomobject]@{ Browser = $b; Exe = $exe; Check = $check; Combo = $combo; Profiles = $profiles }
    $top += 104
  }

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "Install"
  $ok.SetBounds(332, 292, 84, 28)
  $ok.DialogResult = "OK"
  $form.AcceptButton = $ok
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.SetBounds(420, 292, 84, 28)
  $cancel.DialogResult = "Cancel"
  $form.CancelButton = $cancel
  $form.Controls.Add($cancel)

  $form.Topmost = $true
  if ($form.ShowDialog() -ne "OK") { exit 0 }

  $chosen = @()
  foreach ($r in $rows) {
    if ($r.Exe -and $r.Check.Checked) {
      $chosen += [pscustomobject]@{ Browser = $r.Browser; Exe = $r.Exe; Profile = $r.Profiles[$r.Combo.SelectedIndex].Dir }
    }
  }
  return [pscustomobject]@{ Folder = $folderBox.Text.Trim(); Browsers = $chosen }
}

# --- 3. Git -------------------------------------------------------------------
function Install-GitIfMissing {
  Write-Step "Checking for Git"
  if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "Git is installed."; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw ("Git isn't installed, and winget isn't available to install it. " +
      "Install Git for Windows from https://git-scm.com/download/win, then run setup again.")
  }
  Write-Host "Installing Git with winget. Approve the Windows prompt if one appears."
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  Update-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git didn't install, or this window can't see it yet. Run setup again; it will skip what's already done."
  }
  Write-Host "Git installed." -ForegroundColor Green
}

# --- 4. The extension's files ---------------------------------------------------
function Get-Extension([string]$Folder) {
  Write-Step "Getting the extension from GitHub"
  if (Test-Path (Join-Path $Folder ".git")) {
    Write-Host "$Folder is already set up; bringing it up to date."
    git -C $Folder pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Couldn't update it (see above), so it stays as it is. Update now in the panel will say why." -ForegroundColor Yellow
    }
    return
  }
  if ((Test-Path $Folder) -and @(Get-ChildItem -Force $Folder).Count -gt 0) {
    throw "$Folder already has other files in it. Pick an empty or new folder, then run setup again."
  }
  git clone $RepoUrl $Folder
  if ($LASTEXITCODE -ne 0) { throw "Couldn't download the extension from GitHub. Check the network, then run setup again." }
}

# --- 5. Update now helper ---------------------------------------------------------
function Register-Updater([string]$Folder) {
  Write-Step "Setting up the Update now button"
  $script = Join-Path $Folder "updater\install-windows.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -NoPause
  if ($LASTEXITCODE -ne 0) { throw "The Update now setup failed; the message above says why." }
}

# --- 6. Open the browser and walk through loading the extension -------------------
# Browsers don't let anything (setup, other extensions) touch their own
# extensions page, so the walkthrough is a small window beside it. It reads the
# profile's preference files every couple of seconds and ticks each step off
# once the browser has saved it (that can take ~10 seconds).

function Read-Json([string]$Path) {
  try { if (Test-Path $Path) { return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json } } catch { }
  return $null
}

# Where this profile stands: developer mode, extension loaded, turned on, pinned.
function Get-LoadState($Browser, [string]$ProfileDir) {
  $dir = Join-Path $Browser.UserData $ProfileDir
  $prefs = Read-Json (Join-Path $dir "Preferences")
  $secure = Read-Json (Join-Path $dir "Secure Preferences")
  $ext = $null
  foreach ($p in @($secure, $prefs)) {
    $settings = $p.extensions.settings
    if ($settings -and $settings.PSObject.Properties[$ExtensionId]) { $ext = $settings.$ExtensionId; break }
  }
  $pinnedList = $prefs.extensions.pinned_extensions
  $reasons = @($ext.disable_reasons) | Where-Object { $_ -and $_ -ne 0 }
  $enabled = [bool]$ext -and ($ext.state -ne 0) -and (@($reasons).Count -eq 0)
  # Only Chrome records pins where we can read them; elsewhere this step is ticked by hand.
  $pinned = $null
  if ($null -ne $pinnedList) { $pinned = @($pinnedList) -contains $ExtensionId }
  return [pscustomobject]@{
    DevMode = [bool]$prefs.extensions.ui.developer_mode
    Loaded  = [bool]$ext
    Enabled = $enabled
    Pinned  = $pinned
  }
}

function Show-LoadCoach($Choice, [string]$Folder) {
  $b = $Choice.Browser
  $isEdge = $b.Process -eq "msedge"
  if ($isEdge) {
    $devText = "On the Extensions page, look at the menu on the left. Near the bottom, switch Developer mode on."
    $tabName = "Extensions"
    $loadWhere = "(it appears under Installed extensions once Developer mode is on)"
    $pinText = "Click the puzzle-piece (Extensions) button in Edge's toolbar, then the eye icon next to WorkWithPriends for WellSky so it shows in the toolbar. Then click This step is done."
  } else {
    $devText = "On the Extensions page, look at the top-right corner. Switch Developer mode on (the switch turns blue)."
    $tabName = "My extensions"
    $loadWhere = "(top-left, under the blue bar)"
    $pinText = "Click the puzzle-piece button at the top-right of Chrome, then the pin next to WorkWithPriends for WellSky."
  }
  $loadText = "Make sure $tabName is selected in the menu on the left. Click Load unpacked $loadWhere.`n`n" +
    "In the folder window: click the address bar at the top, press Ctrl+V, press Enter, then click Select Folder.`n`n" +
    "The folder is already copied:`n$Folder"
  $onText = "Find the WorkWithPriends for WellSky card (navy clipboard icon). Its switch should be on (blue). If it's off, switch it on. If the card shows an Errors button, tell Jake."
  $steps = @(
    [pscustomobject]@{ Title = "Turn on Developer mode"; Detail = $devText; Check = { param($s) $s.DevMode } },
    [pscustomobject]@{ Title = "Load unpacked, then paste the folder"; Detail = $loadText; Check = { param($s) $s.Loaded } },
    [pscustomobject]@{ Title = "Check WorkWithPriends is turned on"; Detail = $onText; Check = { param($s) $s.Loaded -and $s.Enabled } },
    [pscustomobject]@{ Title = "Pin it to the toolbar"; Detail = $pinText; Check = { param($s) $s.Pinned } }
  )
  $manualDone = @{}

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Add WorkWithPriends to $($b.Name)"
  $form.FormBorderStyle = "FixedToolWindow"
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $form.ClientSize = New-Object System.Drawing.Size(380, 470)
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.StartPosition = "Manual"
  $form.Location = New-Object System.Drawing.Point(($area.Right - 400), ($area.Top + 80))

  $intro = New-Object System.Windows.Forms.Label
  $intro.Text = "Follow these steps on the Extensions page. Each one ticks itself off once $($b.Name) saves it (give it a few seconds)."
  $intro.SetBounds(14, 10, 352, 44)
  $form.Controls.Add($intro)

  $stepLabels = @()
  $y = 60
  foreach ($st in $steps) {
    $l = New-Object System.Windows.Forms.Label
    $l.SetBounds(14, $y, 352, 24)
    $form.Controls.Add($l)
    $stepLabels += $l
    $y += 26
  }

  $detail = New-Object System.Windows.Forms.Label
  $detail.SetBounds(14, ($y + 8), 352, 200)
  $detail.BackColor = [System.Drawing.Color]::FromArgb(255, 244, 214)
  $detail.Padding = New-Object System.Windows.Forms.Padding(8)
  $form.Controls.Add($detail)

  $next = New-Object System.Windows.Forms.Button
  $next.Text = "This step is done"
  $next.SetBounds(14, 380, 170, 30)
  $form.Controls.Add($next)

  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = "Copy folder again"
  $copy.SetBounds(196, 380, 170, 30)
  $copy.Add_Click({ Set-Clipboard -Value $Folder })
  $form.Controls.Add($copy)

  $reopen = New-Object System.Windows.Forms.Button
  $reopen.Text = "Reopen Extensions page"
  $reopen.SetBounds(14, 420, 170, 30)
  $reopen.Add_Click({ Start-Process -FilePath $Choice.Exe -ArgumentList @("--profile-directory=`"$($Choice.Profile)`"", $b.ExtensionsPage) })
  $form.Controls.Add($reopen)

  $finish = New-Object System.Windows.Forms.Button
  $finish.Text = "Close"
  $finish.SetBounds(196, 420, 170, 30)
  $finish.DialogResult = "OK"
  $form.Controls.Add($finish)

  $script:coachCurrent = 0
  $refresh = {
    $state = Get-LoadState $b $Choice.Profile
    $current = -1
    for ($i = 0; $i -lt $steps.Count; $i++) {
      $done = $manualDone[$i] -or [bool](& $steps[$i].Check $state)
      # A later step being done means the earlier ones were too (prefs can lag).
      if (-not $done -and $i -lt 3 -and $state.Loaded -and $state.Enabled) { $done = $true }
      if (-not $done -and $current -lt 0) { $current = $i }
      $mark = if ($done) { [char]0x2714 } elseif ($i -eq $current) { [char]0x25B6 } else { [char]0x25CB }
      $stepLabels[$i].Text = "$mark  $($i + 1). $($steps[$i].Title)"
      $stepLabels[$i].ForeColor = if ($done) { [System.Drawing.Color]::FromArgb(46, 122, 76) } elseif ($i -eq $current) { [System.Drawing.Color]::Black } else { [System.Drawing.Color]::Gray }
      $stepLabels[$i].Font = New-Object System.Drawing.Font("Segoe UI", 10, $(if ($i -eq $current) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }))
    }
    $script:coachCurrent = $current
    if ($current -lt 0) {
      $detail.Text = "All set. WorkWithPriends for WellSky is loaded and turned on.`n`nClick Close to open WellSky, then click the WorkWithPriends button in the toolbar to show the dashboard."
      $detail.BackColor = [System.Drawing.Color]::FromArgb(231, 246, 236)
      $next.Enabled = $false
      $finish.Text = "Close and open WellSky"
    } else {
      $detail.Text = $steps[$current].Detail
      $next.Enabled = $true
    }
  }
  $next.Add_Click({ if ($script:coachCurrent -ge 0) { $manualDone[$script:coachCurrent] = $true }; & $refresh })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 2000
  $timer.Add_Tick($refresh)
  $form.Add_Shown({ & $refresh; $timer.Start() })
  $form.Add_FormClosed({ $timer.Stop() })
  [void]$form.ShowDialog()
}

function Open-Browsers([string]$Folder, $Chosen) {
  $needsLoading = @($Chosen | Where-Object { -not (Test-ExtensionLoaded $_.Browser $_.Profile) })
  $text = "Setup is done.`n`nOpen the browser now"
  if ($needsLoading.Count -gt 0) { $text += " so you can add the extension" }
  $text += " and go to WellSky?"
  if ((Show-Message $text "YesNo" "Question") -ne "Yes") { return }

  foreach ($c in $Chosen) {
    $profileArg = "--profile-directory=`"$($c.Profile)`""
    if ($needsLoading -contains $c) {
      # Browsers no longer let setup add an extension, so walk through it by hand.
      Set-Clipboard -Value $Folder
      Start-Process -FilePath $c.Exe -ArgumentList @($profileArg, $c.Browser.ExtensionsPage)
      Start-Sleep -Seconds 2
      Show-LoadCoach $c $Folder
    }
    Start-Process -FilePath $c.Exe -ArgumentList @($profileArg, $WellSkyUrl)
  }
}

# --- Run ----------------------------------------------------------------------------
try {
  Write-Host "WorkWithPriends setup" -ForegroundColor Cyan
  Confirm-BrowsersClosed
  $choice = Show-SetupForm
  if (-not $choice.Folder) { throw "No folder was chosen." }
  if ($choice.Browsers.Count -eq 0) { throw "Pick at least one browser." }

  Install-GitIfMissing
  Get-Extension $choice.Folder
  Register-Updater $choice.Folder

  Write-Host ""
  Write-Host "All done." -ForegroundColor Green
  Open-Browsers $choice.Folder $choice.Browsers
} catch {
  Write-Host ""
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
  Show-Message "Setup failed:`n`n$($_.Exception.Message)`n`nThe setup window has more detail." "OK" "Error" | Out-Null
  Write-Host ""
  Read-Host "Press Enter to close this window" | Out-Null
  exit 1
}
