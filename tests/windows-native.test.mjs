import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,parse,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {windowsNative,windowsExecutable} from '../cli/platform-storage.mjs';

// Only disposable paths and allowlisted diagnostic metadata; never real custody.
test('Windows native helper parses and protects a disposable private state path',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'commerce-native-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'input.json');await writeFile(file,'{}');
  const script=String.raw`
    $ErrorActionPreference='Stop'
    try {
    $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
    $tokens=$null; $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($r.helper,[ref]$tokens,[ref]$errors)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted=@($sid,'S-1-5-18','S-1-5-32-544')
    $acl=Get-Acl -LiteralPath $r.path
    $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    $untrusted=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted -and ($_.FileSystemRights -band $mutation) -ne 0})
    $inheritOnly=@($untrusted|Where-Object {($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0})
    [Console]::Out.Write((@{parse_errors=@($errors).Count;policy=[string](Get-ExecutionPolicy);owner_trusted=($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $trusted);untrusted_mutation=$untrusted.Count;inherit_only_mutation=$inheritOnly.Count}|ConvertTo-Json -Compress))
    } catch { [Console]::Out.Write((@{probe_error_type=$_.Exception.GetType().FullName;line=$_.InvocationInfo.ScriptLineNumber;error_id=$_.FullyQualifiedErrorId}|ConvertTo-Json -Compress));exit 1 }
  `;
  const helper=fileURLToPath(new URL('../cli/native/windows-storage.ps1',import.meta.url));
  const inspect=path=>{
    const r=spawnSync(windowsExecutable(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({helper,path}),encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,`metadata probe failed: ${r.stdout.slice(0,1000)}`);return JSON.parse(r.stdout);
  };
  const results=[];
  for(const operation of ['input','protect','check']){
    try{await windowsNative({operation,path:operation==='input'?file:root});results.push({operation,ok:true});}
    catch(error){results.push({operation,ok:false,code:error.code});}
  }
  let path=parse(root).root;
  for(const part of root.slice(path.length).split(sep).filter(Boolean)){
    path=join(path,part);const metadata=inspect(path);
    try{await windowsNative({operation:'ancestor',path});results.push({operation:'ancestor',...metadata,ok:true});}
    catch(error){results.push({operation:'ancestor',...metadata,ok:false,code:error.code});}
  }
  t.diagnostic(JSON.stringify(results));
  assert.ok(results.every(x=>x.ok),'native helper must accept the disposable protected path and its safe ancestry; see sanitized metadata');
});
