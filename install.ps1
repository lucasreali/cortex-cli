#Requires -Version 5.1
# The Windows half of install.sh. Same contract, expressed against what ships
# in the box: Invoke-WebRequest instead of curl, Get-FileHash instead of
# sha256sum, and tar.exe — bundled since Windows 10 1803 — for the same ustar
# tarball the POSIX side reads.
# No Set-StrictMode: the redirect below is read through a property that
# Windows PowerShell and PowerShell 7 spell differently, and strict mode turns
# probing for the other one into a terminating error.
$ErrorActionPreference = 'Stop'

$Repo = 'lucasreali/cortex-cli'
$InstallDir = if ($env:CORTEX_INSTALL_DIR) {
	$env:CORTEX_INSTALL_DIR
} else {
	Join-Path $env:LOCALAPPDATA 'Programs\cortex'
}

function Die($message) {
	[Console]::Error.WriteLine("cortex: $message")
	exit 1
}

function Require-Command($name) {
	if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
		Die "$name is required but was not found (Windows 10 1803 or later ships it)"
	}
}

# src/release/target.ts resolves the same suffix for `cortex upgrade`. Bun
# cross-compiles no windows-arm64 and Windows on ARM runs an x64 image under
# emulation, so there is one answer here and targetForHost gives the same one.
# Changing the rule here without changing it there splits install from upgrade.
function Get-Suffix {
	switch ($env:PROCESSOR_ARCHITECTURE) {
		'AMD64' { 'windows-x64' }
		'ARM64' { 'windows-x64' }
		'x86' {
			# A 32-bit shell on a 64-bit machine reports x86 and names the real
			# architecture in the other variable; a genuinely 32-bit Windows
			# leaves that one empty, and no asset exists for it.
			if ($env:PROCESSOR_ARCHITEW6432) { 'windows-x64' }
			else { Die "unsupported architecture: 32-bit Windows" }
		}
		default { Die "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
	}
}

# The /releases/latest redirect, not the API: no token, no rate limit. TLS is
# pinned by the scheme and PowerShell follows no downgrade to http.
function Get-LatestVersion {
	try {
		$response = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
			-MaximumRedirection 5 -UseBasicParsing
	} catch {
		Die "could not reach https://github.com/$Repo/releases"
	}
	# Windows PowerShell exposes the final address as ResponseUri; PowerShell 7
	# moved it under the request message it was answered from.
	$url = "$($response.BaseResponse.ResponseUri)"
	if (-not $url) { $url = "$($response.BaseResponse.RequestMessage.RequestUri)" }
	if ($url -match '/releases/tag/(.+)$') { return $Matches[1] }
	Die "no published release found at https://github.com/$Repo/releases"
}

function Resolve-Version {
	if (-not $env:CORTEX_VERSION) { return Get-LatestVersion }
	if ($env:CORTEX_VERSION.StartsWith('v')) { $env:CORTEX_VERSION }
	else { "v$($env:CORTEX_VERSION)" }
}

# Verification is not optional, and a name that is not listed is a failure
# rather than a skip — the same rule install.sh's awk lookup enforces.
function Assert-Checksum($file, $name, $checksums) {
	$line = Select-String -Path $checksums -Pattern "\s$([regex]::Escape($name))$" |
		Select-Object -First 1
	if (-not $line) { Die "$name is not listed in checksums.txt" }
	$expected = ($line.Line -split '\s+')[0]
	$actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
	if ($expected -ne $actual) {
		Die "checksum mismatch for $name`n  expected $expected`n  actual   $actual"
	}
}

# Windows refuses a rename onto a running image, so an existing cortex.exe is
# renamed out of the way before the new one takes its place. The retired file
# cannot be deleted while something still runs it; a later install sweeps it,
# exactly as src/release/installer.ts does.
function Install-Binary($staging, $target) {
	if (-not (Test-Path -LiteralPath $target)) {
		Move-Item -LiteralPath $staging -Destination $target -Force
		return
	}
	$retired = "$target.$PID.old"
	Move-Item -LiteralPath $target -Destination $retired -Force
	try {
		Move-Item -LiteralPath $staging -Destination $target -Force
	} catch {
		Move-Item -LiteralPath $retired -Destination $target -Force
		throw
	}
	Remove-Item -LiteralPath $retired -Force -ErrorAction SilentlyContinue
}

function Remove-Leftovers($directory) {
	Get-ChildItem -Path $directory -Filter 'cortex.exe.*' -ErrorAction SilentlyContinue |
		Where-Object { $_.Name -match '\.\d+\.(old|partial)(\.exe)?$' } |
		ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

# Windows has a per-user PATH to write and no rc file to point at, so this
# writes rather than hints. The current session is updated too, because the
# registry change reaches only processes started afterwards.
function Add-ToUserPath($directory) {
	$current = [Environment]::GetEnvironmentVariable('Path', 'User')
	$entries = if ($current) { $current -split ';' } else { @() }
	if ($entries -contains $directory) { return }
	$updated = (@($entries | Where-Object { $_ }) + $directory) -join ';'
	[Environment]::SetEnvironmentVariable('Path', $updated, 'User')
	$env:Path = "$env:Path;$directory"
	Write-Host "  added $directory to your user PATH (new terminals pick it up)"
}

function Install-Cortex {
	Require-Command tar

	$suffix = Get-Suffix
	$version = Resolve-Version
	$asset = "cortex-$version-$suffix.tar.gz"
	$base = "https://github.com/$Repo/releases/download/$version"

	New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
	Remove-Leftovers $InstallDir
	$temp = Join-Path ([System.IO.Path]::GetTempPath()) "cortex-install-$PID"
	New-Item -ItemType Directory -Force -Path $temp | Out-Null

	# Staged inside $InstallDir, never in the temp directory: a move across
	# volumes copies into a fresh file, which would leave a half-written
	# cortex.exe on disk for the length of the copy.
	$staging = Join-Path $InstallDir "cortex.exe.$PID.partial.exe"
	$target = Join-Path $InstallDir 'cortex.exe'

	try {
		Write-Host "cortex: downloading $asset"
		# The progress bar makes Invoke-WebRequest roughly an order of
		# magnitude slower on a 60 MB asset in PowerShell 5.1.
		$progress = $ProgressPreference
		$ProgressPreference = 'SilentlyContinue'
		try {
			Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $temp $asset) -UseBasicParsing
			Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile (Join-Path $temp 'checksums.txt') -UseBasicParsing
		} catch {
			Die "failed to download $base/$asset"
		} finally {
			$ProgressPreference = $progress
		}

		Assert-Checksum (Join-Path $temp $asset) $asset (Join-Path $temp 'checksums.txt')

		tar.exe -xzf (Join-Path $temp $asset) -C $temp
		if ($LASTEXITCODE -ne 0) { Die "could not unpack $asset" }
		$unpacked = Join-Path $temp 'cortex.exe'
		if (-not (Test-Path -LiteralPath $unpacked)) {
			Die "$asset did not contain a cortex.exe executable"
		}

		Copy-Item -LiteralPath $unpacked -Destination $staging -Force
		$reported = & $staging --version 2>$null
		if ($LASTEXITCODE -ne 0) { Die "the downloaded binary does not run here" }
		if ("v$reported".Trim() -ne $version) {
			Die "the downloaded binary reports v$reported, expected $version"
		}
		Install-Binary $staging $target
	} finally {
		Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
	}

	Write-Host "cortex $version installed to $target"
	Add-ToUserPath $InstallDir
	Write-Host ""
	Write-Host "  Next: run ``cortex install`` to register with your coding agents,"
	Write-Host "  then ``cortex init`` in a repository."
	Write-Host "  The first embedding downloads the model (~hundreds of MB) from HuggingFace."
	Write-Host "  Later: ``cortex upgrade`` replaces this binary in place."
}

# Dot-sourcing with CORTEX_SOURCE_ONLY set exposes the functions without
# installing, so CI can compare Get-Suffix against src/release/target.ts.
if (-not $env:CORTEX_SOURCE_ONLY) { Install-Cortex }
