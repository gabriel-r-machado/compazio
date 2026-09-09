param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
$signature.Status.ToString()
