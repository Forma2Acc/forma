'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
// Direct CurrentUser DPAPI keeps the access vault readable by both Electron
// applications under this Windows login. Electron safeStorage may use a
// different encryption key for each application's Local State profile.
const ENTROPY=Buffer.from('FormaAccess-v1','utf8');
const POSIX_MAGIC=Buffer.from('FRMV1','ascii');
function posixVaultDir(){
 const base=process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config');
 return path.join(base,'FormaAccess');
}
function readMachineSecret(){
 for(const candidate of ['/etc/machine-id','/var/lib/dbus/machine-id']){
  try{
   const v=fs.readFileSync(candidate,'utf8').trim();
   if(v)return v;
  }catch{}
 }
 return `${os.hostname()}:${os.platform()}:${os.arch()}`;
}
function posixKey(){
 const dir=posixVaultDir();
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const saltPath=path.join(dir,'.vault-salt');
 let salt;
 try{
  salt=fs.readFileSync(saltPath);
  if(salt.length<32)throw Error('short salt');
 }catch{
  salt=crypto.randomBytes(32);
  fs.writeFileSync(saltPath,salt,{mode:0o600});
 }
 try{fs.chmodSync(saltPath,0o600)}catch{}
 const uid=typeof process.getuid==='function'?String(process.getuid()):String((os.userInfo&&os.userInfo().uid)||0);
 const ikm=Buffer.concat([ENTROPY,Buffer.from(`:${readMachineSecret()}:${uid}:${os.homedir()}`,'utf8')]);
 return crypto.scryptSync(ikm,salt,32,{N:16384,r:8,p:1});
}
function posixEncrypt(plain){
 const iv=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',posixKey(),iv);
 cipher.setAAD(ENTROPY);
 const enc=Buffer.concat([cipher.update(plain),cipher.final()]);
 const tag=cipher.getAuthTag();
 return Buffer.concat([POSIX_MAGIC,iv,tag,enc]);
}
function posixDecrypt(blob){
 const buf=Buffer.from(blob);
 if(buf.length<POSIX_MAGIC.length+12+16)throw Error('Invalid encrypted vault payload.');
 if(!buf.subarray(0,POSIX_MAGIC.length).equals(POSIX_MAGIC))throw Error('Unsupported encrypted vault header.');
 const ivStart=POSIX_MAGIC.length;
 const tagStart=ivStart+12;
 const encStart=tagStart+16;
 const decipher=crypto.createDecipheriv('aes-256-gcm',posixKey(),buf.subarray(ivStart,tagStart));
 decipher.setAAD(ENTROPY);
 decipher.setAuthTag(buf.subarray(tagStart,encStart));
 return Buffer.concat([decipher.update(buf.subarray(encStart)),decipher.final()]);
}
function crypt(value,decrypt){
 if(process.platform==='linux'||process.platform==='darwin'){
  return Promise.resolve().then(()=>decrypt?posixDecrypt(value):posixEncrypt(Buffer.from(value)));
 }
 if(process.platform!=='win32')return Promise.reject(Error('Encrypted storage is unavailable on this platform.'));
 const command="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('FormaAccess-v1');$r=[Security.Cryptography.ProtectedData]::"+(decrypt?'Unprotect':'Protect')+"($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))";
 return new Promise((resolve,reject)=>{
  const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill();reject(Error('Windows credential encryption timed out.'))},15000);
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>20000){failed=true;child.kill();reject(Error('Unexpected credential response.'))}});
  child.stderr.on('data',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Windows credential encryption could not start.'))});
  child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)return reject(Error('Windows credential encryption failed.'));try{resolve(Buffer.from(output.trim(),'base64'))}catch{reject(Error('Invalid credential response.'))}});
  child.stdin.on('error',()=>{});child.stdin.end(Buffer.from(value).toString('base64'));
 });
}
module.exports={isEncryptionAvailable:()=>process.platform==='win32'||process.platform==='linux'||process.platform==='darwin',encryptString:value=>crypt(Buffer.from(value,'utf8'),false),decryptString:async value=>(await crypt(value,true)).toString('utf8')};
