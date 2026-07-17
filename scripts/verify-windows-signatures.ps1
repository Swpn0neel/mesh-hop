[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string[]] $Path
)

$ErrorActionPreference = "Stop"
$expectedThumbprint = ($env:WINDOWS_CERTIFICATE_THUMBPRINT -replace "\s", "").ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($expectedThumbprint)) {
  throw "WINDOWS_CERTIFICATE_THUMBPRINT is required to verify release signatures."
}

foreach ($candidate in $Path) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Expected signed release file was not found: $candidate"
  }

  $target = (Resolve-Path -LiteralPath $candidate).Path
  $signature = Get-AuthenticodeSignature -FilePath $target
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Signature validation failed for $target ($($signature.Status))."
  }
  $actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace "\s", "").ToUpperInvariant()
  if ($actualThumbprint -ne $expectedThumbprint) {
    throw "Unexpected signing certificate for $target."
  }
  Write-Host "Verified release signature: $target"
}
