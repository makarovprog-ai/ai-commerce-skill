$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.operation -eq 'input') {
    $item = Get-Item -LiteralPath $request.path -Force
    if ($item.PSIsContainer) { throw 'unsafe' }
    while ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
      if ($item -is [IO.FileInfo]) { $item = $item.Directory }
      else { $item = $item.Parent }
    }
    [Console]::Out.Write('{"ok":true}')
  } elseif ($request.operation -in @('check', 'protect', 'ancestor')) {
    $item = Get-Item -LiteralPath $request.path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
    if ($request.operation -eq 'ancestor') {
      $acl = Get-Acl -LiteralPath $request.path
      $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'unsafe' }
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      if ($rules.Count -eq 0) { throw 'unsafe' }
      $mutation = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
      foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and (($rule.FileSystemRights -band $mutation) -ne 0)) { throw 'unsafe' }
      }
      [Console]::Out.Write('{"ok":true}')
      exit 0
    }
    if ($request.operation -eq 'protect') {
      if ($item.PSIsContainer) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
      else { $acl = New-Object System.Security.AccessControl.FileSecurity }
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $request.path -AclObject $acl
    }
    $acl = Get-Acl -LiteralPath $request.path
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) { throw 'unsafe' }
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    $allowed = $false
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'unsafe' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and $rule.AccessControlType -eq 'Allow' -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $allowed = $true }
    }
    if (!$allowed) { throw 'unsafe' }
    [Console]::Out.Write('{"ok":true}')
  } elseif ($request.operation -in @('seal', 'unprotect')) {
    Add-Type -AssemblyName System.Security
    if ($request.id -notmatch '^[0-9a-f]{64}$') { throw 'unsafe' }
    $entropy = [Text.Encoding]::UTF8.GetBytes('ai-commerce-vault-v1:' + $request.id)
    if ($request.operation -eq 'seal') {
      if ($request.value -notmatch '^[0-9a-f]{64}$') { throw 'unsafe' }
      $clear = New-Object byte[] 32
      for ($i=0; $i -lt 32; $i++) { $clear[$i] = [Convert]::ToByte($request.value.Substring($i*2,2),16) }
      try { $bytes = [Security.Cryptography.ProtectedData]::Protect($clear,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
      finally { [Array]::Clear($clear,0,$clear.Length) }
      $value = [Convert]::ToBase64String($bytes)
    } else {
      $bytes = [Convert]::FromBase64String($request.value)
      $clear = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      try { if ($clear.Length -ne 32) { throw 'unsafe' }; $value = ([BitConverter]::ToString($clear)).Replace('-','').ToLowerInvariant() }
      finally { [Array]::Clear($clear,0,$clear.Length) }
    }
    [Console]::Out.Write((@{value=$value} | ConvertTo-Json -Compress))
  } else { throw 'unsafe' }
} catch { [Console]::Error.Write('native_storage_failed'); exit 1 }
