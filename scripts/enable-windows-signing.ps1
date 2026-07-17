[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Require-EnvironmentValue([string] $Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "${Name} must be set before Windows code signing can be enabled."
  }
  return $value
}

if ([string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) {
  throw "enable-windows-signing.ps1 is intended for GitHub Actions and requires GITHUB_ENV."
}

$encodedCertificate = Require-EnvironmentValue "WINDOWS_CERTIFICATE"
$certificatePassword = Require-EnvironmentValue "WINDOWS_CERTIFICATE_PASSWORD"
$timestampUrl = Require-EnvironmentValue "WINDOWS_TIMESTAMP_URL"

try {
  $timestampUri = [Uri] $timestampUrl
} catch {
  throw "WINDOWS_TIMESTAMP_URL must be an absolute HTTP(S) timestamp URL."
}
if (-not $timestampUri.IsAbsoluteUri -or $timestampUri.Scheme -notin @("http", "https")) {
  throw "WINDOWS_TIMESTAMP_URL must be an absolute HTTP(S) timestamp URL."
}

# Accept plain base64 as well as a certutil-style PEM wrapper. Whitespace is
# deliberately removed because GitHub secrets may contain wrapped lines.
$normalizedBase64 = $encodedCertificate `
  -replace "-----BEGIN CERTIFICATE-----", "" `
  -replace "-----END CERTIFICATE-----", "" `
  -replace "\s", ""

try {
  $certificateBytes = [Convert]::FromBase64String($normalizedBase64)
} catch {
  throw "WINDOWS_CERTIFICATE must contain a base64-encoded PFX file."
}

$certificatePath = Join-Path $env:RUNNER_TEMP "meshhop-signing.pfx"
$securePassword = ConvertTo-SecureString -String $certificatePassword -AsPlainText -Force

try {
  [IO.File]::WriteAllBytes($certificatePath, $certificateBytes)
  $certificates = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\My" -Password $securePassword)
} finally {
  Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
}

$certificate = $certificates | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
if (-not $certificate -or [string]::IsNullOrWhiteSpace($certificate.Thumbprint) -or -not $certificate.HasPrivateKey) {
  throw "The supplied PFX did not import a certificate with a private key."
}

$thumbprint = ($certificate.Thumbprint -replace "\s", "").ToUpperInvariant()
$tauriConfig = @{
  bundle = @{
    windows = @{
      certificateThumbprint = $thumbprint
      digestAlgorithm = "sha256"
      timestampUrl = $timestampUri.AbsoluteUri
    }
  }
} | ConvertTo-Json -Compress -Depth 5

"MESHOP_SIGNING_ENABLED=true" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"WINDOWS_CERTIFICATE_THUMBPRINT=$thumbprint" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"TAURI_CONFIG=$tauriConfig" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Windows signing enabled for certificate thumbprint $thumbprint."
