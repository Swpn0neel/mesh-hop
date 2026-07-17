[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string] $Path
)

$ErrorActionPreference = "Stop"

function Get-SignToolPath {
  if (-not [string]::IsNullOrWhiteSpace($env:TAURI_WINDOWS_SIGNTOOL_PATH)) {
    if (-not (Test-Path -LiteralPath $env:TAURI_WINDOWS_SIGNTOOL_PATH -PathType Leaf)) {
      throw "TAURI_WINDOWS_SIGNTOOL_PATH does not point to a file."
    }
    return (Resolve-Path -LiteralPath $env:TAURI_WINDOWS_SIGNTOOL_PATH).Path
  }

  $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path -LiteralPath $sdkRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $sdkRoot -Filter signtool.exe -File -Recurse |
      Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw "signtool.exe was not found. Install the Windows SDK or set TAURI_WINDOWS_SIGNTOOL_PATH."
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  throw "Signing target was not found: $Path"
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_THUMBPRINT)) {
  throw "WINDOWS_CERTIFICATE_THUMBPRINT is required to sign $Path."
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)) {
  throw "WINDOWS_TIMESTAMP_URL is required to sign $Path."
}

$target = (Resolve-Path -LiteralPath $Path).Path
$thumbprint = ($env:WINDOWS_CERTIFICATE_THUMBPRINT -replace "\s", "").ToUpperInvariant()
$signTool = Get-SignToolPath
& $signTool sign /sha1 $thumbprint /fd SHA256 /tr $env:WINDOWS_TIMESTAMP_URL /td SHA256 /v $target
if ($LASTEXITCODE -ne 0) {
  throw "signtool failed while signing $target (exit code $LASTEXITCODE)."
}

$signature = Get-AuthenticodeSignature -FilePath $target
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Signed file did not validate: $target ($($signature.Status))."
}
if (($signature.SignerCertificate.Thumbprint -replace "\s", "").ToUpperInvariant() -ne $thumbprint) {
  throw "Signed file has a certificate other than WINDOWS_CERTIFICATE_THUMBPRINT: $target"
}
Write-Host "Verified signature for $target."
