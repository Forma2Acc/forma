'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {spawn}=require('node:child_process');
const INSTALLER_URL='https://download.qwen.ai/windows/x64/Qwen-1.0.3.44-release-win-x64.exe';
const INSTALLER_HASH='393e4669402e48f3fa6cffd0ebaadfe597b06fb26a11b6aaf03f7ee74df26e60';
const MAX_BYTES=200*1024*1024;
async function downloadInstaller({folder,fetchImpl=globalThis.fetch,onProgress=()=>{},url=INSTALLER_URL,sha256=INSTALLER_HASH}) {
 const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='download.qwen.ai'||u.username||u.password||u.port)throw Error('The Qwen download address is not trusted.');
 await fsp.mkdir(folder,{recursive:true});const temp=await fsp.mkdtemp(path.join(folder,'qwen-setup-'));const file=path.join(temp,'Qwen-setup.exe');
 try {
  const r=await fetchImpl(u.href,{redirect:'error',signal:AbortSignal.timeout(300000)});if(!r.ok||!r.body)throw Error('The official Qwen download failed (HTTP '+r.status+'). Check your connection and retry.');
  const total=Number(r.headers.get('content-length')||0);if(total>MAX_BYTES)throw Error('The Qwen installer is larger than expected.');
  const digest=crypto.createHash('sha256');let size=0,last=0;
  const limit=new Transform({transform(chunk,_enc,cb){size+=chunk.length;if(size>MAX_BYTES)return cb(Error('The Qwen download is larger than expected.'));digest.update(chunk);if(Date.now()-last>1000){last=Date.now();onProgress(size,total)}cb(null,chunk)}});
  await pipeline(Readable.fromWeb(r.body),limit,fs.createWriteStream(file,{flags:'wx',mode:0o600}));
  if(!size||(total&&size!==total)||digest.digest('hex')!==sha256)throw Error('Qwen download verification failed. Retry; no installer was run.');
  onProgress(size,total);return {file,temp};
 } catch(e){await fsp.rm(temp,{recursive:true,force:true});throw e}
}
function runInstaller(file,{spawnImpl=spawn,timeoutMs=300000}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawnImpl(file,['/S','/currentuser'],{windowsHide:true,stdio:'ignore'});let finished=false;
  const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve()};
  const timer=setTimeout(()=>{child.kill();finish(Error('Qwen installation timed out. Restart Forma and try again.'))},timeoutMs);
  child.once('error',()=>finish(Error('The Qwen installer could not start. Check Windows security messages and try again.')));
  child.once('close',code=>finish(code===0?null:Error('Qwen setup did not finish (exit '+code+'). Try again.')));
 });
}
async function installQwen({folder,onProgress=()=>{},requireActive=()=>{},download=downloadInstaller,run=runInstaller,verify}){
 let item;
 try{requireActive();item=await download({folder,onProgress});requireActive();await run(item.file);if(!await verify())throw Error('Qwen setup completed but the expected installation was not found. Restart Forma and try again.');requireActive()}
 finally{if(item)await fsp.rm(item.temp,{recursive:true,force:true}).catch(()=>{})}
}
module.exports={INSTALLER_URL,INSTALLER_HASH,downloadInstaller,runInstaller,installQwen};
