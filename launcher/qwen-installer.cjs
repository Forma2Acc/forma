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
const MAX_REDIRECTS=5;
const MAX_ATTEMPTS=3;

function isTrustedQwenDownloadUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return (
    h === 'download.qwen.ai' ||
    h.endsWith('.qwen.ai') ||
    h.endsWith('.aliyuncs.com') ||
    h === 'github.com' ||
    h.endsWith('.githubusercontent.com')
  );
}

async function fetchWithTrustedRedirects(fetchImpl, startUrl, { timeoutMs = 300000 } = {}) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isTrustedQwenDownloadUrl(current)) {
      throw Error('The Qwen download address is not trusted.');
    }
    const r = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (r && r.status >= 300 && r.status < 400) {
      const loc = r.headers?.get?.('location');
      try { await r.body?.cancel?.(); } catch {}
      if (!loc) throw Error('The official Qwen download redirect was missing a target.');
      if (hop >= MAX_REDIRECTS) throw Error('Too many redirects while downloading Qwen.');
      current = new URL(loc, current).href;
      continue;
    }
    if (r?.url && !isTrustedQwenDownloadUrl(r.url)) {
      try { await r.body?.cancel?.(); } catch {}
      throw Error('The Qwen download redirected to an untrusted host.');
    }
    return r;
  }
  throw Error('Too many redirects while downloading Qwen.');
}

function toNodeReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return Readable.from(body);
}

async function downloadInstaller({folder,fetchImpl=globalThis.fetch,onProgress=()=>{},url=INSTALLER_URL,sha256=INSTALLER_HASH}) {
 if(!isTrustedQwenDownloadUrl(url))throw Error('The Qwen download address is not trusted.');
 await fsp.mkdir(folder,{recursive:true});const temp=await fsp.mkdtemp(path.join(folder,'qwen-setup-'));const file=path.join(temp,'Qwen-setup.exe');
 let lastError=null;
 try {
  for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
   try{
    const r=await fetchWithTrustedRedirects(fetchImpl,url,{timeoutMs:300000});
    if(!r.ok||!r.body){
     const httpErr=Error('The official Qwen download failed (HTTP '+r.status+'). Check your connection or Cloudflare WARP and retry.');
     httpErr.retryable=r.status===408||r.status===429||r.status>=500;
     throw httpErr;
    }
    const total=Number(r.headers?.get?.('content-length')||0);
    if(total>MAX_BYTES)throw Error('The Qwen installer is larger than expected.');
    const digest=crypto.createHash('sha256');let size=0,last=0;
    const limit=new Transform({transform(chunk,_enc,cb){size+=chunk.length;if(size>MAX_BYTES)return cb(Error('The Qwen download is larger than expected.'));digest.update(chunk);if(Date.now()-last>1000){last=Date.now();onProgress(size,total)}cb(null,chunk)}});
    await pipeline(toNodeReadable(r.body),limit,fs.createWriteStream(file,{flags:'w',mode:0o600}));
    if(!size||(total&&size!==total)||digest.digest('hex')!==sha256){
     const vErr=Error('Qwen download verification failed. Retry; no installer was run.');
     vErr.retryable=total&&size<total;
     throw vErr;
    }
    onProgress(size,total);return {file,temp};
   }catch(err){
    lastError=err;
    await fsp.unlink(file).catch(()=>{});
    const isTransient=err?.retryable||/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up|aborted|premature|network|stream/i.test(String(err?.message||''));
    if(!isTransient||attempt>=MAX_ATTEMPTS)throw err;
    await new Promise(resolve=>setTimeout(resolve,800*attempt));
   }
  }
  throw lastError||Error('The official Qwen download failed.');
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
