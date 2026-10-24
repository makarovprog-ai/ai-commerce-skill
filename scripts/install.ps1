# Run this reviewed local file. Never change execution policy for this installer.
$ErrorActionPreference = 'Stop'
$installerArgs = $args
$scriptDirectory = $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    & $node.Source -e 'process.exit(parseInt(process.versions.node) === 24 ? 0 : 1)' 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $node.Source (Join-Path $scriptDirectory 'install.mjs') @installerArgs
        exit $LASTEXITCODE
    }
}
if ($env:OS -ne 'Windows_NT') { throw 'Supply Node.js 24 LTS and run scripts/install.mjs on this OS.' }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw 'Unsupported architecture.' }
$manifest = Get-Content -LiteralPath (Join-Path $scriptDirectory 'runtime-manifest.json') -Raw | ConvertFrom-Json
$runtime = $manifest.platforms."win32-$architecture"
$expectedFile = "node-v24.22.1-win-$architecture.zip"
if ($manifest.version -ne '24.22.1' -or $manifest.origin -ne 'https://nodejs.org' -or $runtime.file -ne $expectedFile -or $runtime.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid pinned runtime manifest.' }
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-commerce-runtime-' + [Guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($stage)
try {
    $archivePath = Join-Path $stage 'runtime.zip'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.22.1/$expectedFile" -OutFile $archivePath -MaximumRedirection 0 -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256) { throw 'Runtime checksum mismatch; nothing was extracted.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $top = $expectedFile.Substring(0, $expectedFile.Length - 4)
        $executable = $null
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name.Contains('\') -or -not $name.StartsWith("$top/", [StringComparison]::Ordinal) -or ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.')) { throw 'Unsafe runtime archive path.' }
            $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixType -notin @(0, 0x8000, 0x4000)) { throw 'Runtime archive contains a link or special file.' }
            if ($name -eq "$top/node.exe") {
                if ($null -ne $executable) { throw 'Duplicate runtime executable.' }
                $executable = $entry
            }
        }
        if ($null -eq $executable) { throw 'Runtime executable missing.' }
        $nodePath = Join-Path $stage 'node.exe'
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($executable, $nodePath, $false)
    } finally { $zip.Dispose() }
    & $nodePath (Join-Path $scriptDirectory 'install.mjs') @installerArgs
    $installExitCode = $LASTEXITCODE
} finally {
    # Only the exact GUID directory created by this invocation is removed.
    Remove-Item -LiteralPath $stage -Recurse -Force
}
exit $installExitCode
