#!/usr/bin/env node
/*
 * post-reels-api.js — Đăng Reel (video dọc 9:16, 3–90s) từ bảng "Đăng Reel" (Lark Base) lên 1 Facebook Page.
 * Dùng LARK OPEN API (app credentials) — KHÔNG cần lark-cli. Chỉ cần Node 18+.
 *
 * Chạy:  node scripts/post-reels-api.js            (đăng thật, tất cả dòng "Chờ đăng")
 *        node scripts/post-reels-api.js --dry-run  (chỉ liệt kê, không đăng)
 *
 * KHÁC post-feed-api.js: đây là nhánh Reel — bảng riêng có cột trạng thái "TT Reel",
 *   đăng cho MỘT page (FB_PAGE_ID/FB_PAGE_TOKEN), không phải mỗi dòng 1 page.
 *
 * CẤU HÌNH qua BIẾN MÔI TRƯỜNG (không hardcode):
 *   LARK_APP_ID       (bắt buộc)  — App ID Lark (cli_...)
 *   LARK_APP_SECRET   (bắt buộc)  — App Secret Lark
 *   LARK_APP_TOKEN    (bắt buộc)  — Base ID/token = GitHub Variable LARK_BASE_ID
 *   LARK_TABLE_ID     (bắt buộc)  — mã bảng Đăng Reel (tbl...) = GitHub Variable TABLE_REEL
 *   FB_PAGE_ID        (bắt buộc)  — ID Facebook Page đích
 *   FB_PAGE_TOKEN     (bắt buộc)  — Page Access Token dài hạn (GitHub Secret)
 * Tùy chọn: LARK_DOMAIN, TRIGGER (mặc định "Chờ đăng"), RESPECT_SCHEDULE ("false" để bỏ qua Lịch đăng).
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');

const CFG = {
  APP_ID:        process.env.LARK_APP_ID     || '',
  APP_SECRET:    process.env.LARK_APP_SECRET || '',
  APP_TOKEN:     process.env.LARK_APP_TOKEN  || '',   // = GitHub Variable LARK_BASE_ID
  TABLE_ID:      process.env.LARK_TABLE_ID   || '',   // = GitHub Variable TABLE_REEL
  FB_PAGE_ID:    process.env.FB_PAGE_ID      || '',
  FB_PAGE_TOKEN: process.env.FB_PAGE_TOKEN   || '',
  LARK_DOMAIN:   process.env.LARK_DOMAIN     || 'https://open.larksuite.com',
  GRAPH_VERSION: 'v21.0',
  TRIGGER:       process.env.TRIGGER         || 'Chờ đăng',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false' // dòng "Lịch đăng" tương lai -> bỏ qua
};
const GRAPH = `https://graph.facebook.com/${CFG.GRAPH_VERSION}`;
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)       _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET)   _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)    _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.TABLE_ID)     _miss.push('LARK_TABLE_ID (=TABLE_REEL)');
if(!DRY && !CFG.FB_PAGE_ID)    _miss.push('FB_PAGE_ID');
if(!DRY && !CFG.FB_PAGE_TOKEN) _miss.push('FB_PAGE_TOKEN');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')+'\n   → khai trong GitHub Secrets/Variables (xem README).'); process.exit(1); }

const F = { trigger:'TT Reel', media:'Ảnh/video', caption:'Nội dung', hashtag:'Hastag', link:'Link Reel', log:'Log đăng Reel', schedule:'Lịch đăng', comment:'Comment ebook' };
const now = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log = (...a) => console.log(now(), ...a);
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||String(v));
const selName = v => { const t=plain(v); return t; };

const sleep = ms => new Promise(r=>setTimeout(r,ms));
/* Bọc MỌI lời gọi Lark: tự chờ rồi thử lại khi dính TooManyRequest (1254290) hoặc lỗi mạng.
 * ⚠️ Thiếu lớp này thì chỉ 1 nhịp Lark chặn là workflow chết FATAL. Xem chú thích cùng nội dung
 * trong post-feed-api.js (sự cố 26/07/2026: cron bắn dày → đụng trần QPS Lark → bài không lên). */
async function larkApi(url, opt={}, label='') {
  for (let i=0; i<6; i++) {
    let j;
    try { const r=await fetch(url, opt); j=await r.json(); }
    catch (netErr) {
      if (i===5) throw new Error(`${label}: lỗi mạng sau 6 lần — ${netErr.message}`);
      await sleep(1500*(i+1)); continue;
    }
    if (j.code === 0) return j;
    if (j.code === 1254290) { await sleep(1500*(i+1)); continue; }   // TooManyRequest → backoff tăng dần
    throw new Error(`${label}: ${j.msg||JSON.stringify(j)} (code ${j.code})`);
  }
  throw new Error(`${label}: TooManyRequest quá nhiều lần`);
}
async function larkToken() {
  const j = await larkApi(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET}) }, 'token');
  if (!j.tenant_access_token) throw new Error('Lark token: '+JSON.stringify(j));
  return j.tenant_access_token;
}
async function listAll(tk) {
  let items=[], pt='';
  do { const j=await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records?page_size=200`+(pt?'&page_token='+pt:''),{headers:{Authorization:'Bearer '+tk}}, 'list');
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; } while(pt);
  return items;
}
async function downloadVideo(tk, fileToken, out) {
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:CFG.TABLE_ID}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for (const u of tries) { const r=await fetch(u,{headers:{Authorization:'Bearer '+tk}});
    if (r.ok && (r.headers.get('content-type')||'').indexOf('json')<0) { const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được video');
}
async function fbFetch(u,o){ const r=await fetch(u,o); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}} if(!r.ok||j.error)throw new Error('FB '+r.status+': '+JSON.stringify(j.error||j._raw||j)); return j; }
async function postReel(videoPath, caption) {
  const start=await fbFetch(`${GRAPH}/${CFG.FB_PAGE_ID}/video_reels?upload_phase=start&access_token=${encodeURIComponent(CFG.FB_PAGE_TOKEN)}`,{method:'POST'});
  const videoId=start.video_id, uploadUrl=start.upload_url;
  if(!videoId||!uploadUrl)throw new Error('start thiếu video_id/upload_url');
  const buf=fs.readFileSync(videoPath);
  await fbFetch(uploadUrl,{method:'POST',headers:{Authorization:`OAuth ${CFG.FB_PAGE_TOKEN}`,offset:'0',file_size:String(buf.length)},body:buf});
  await fbFetch(`${GRAPH}/${CFG.FB_PAGE_ID}/video_reels`,{method:'POST',body:new URLSearchParams({upload_phase:'finish',video_id:videoId,video_state:'PUBLISHED',description:caption||'',access_token:CFG.FB_PAGE_TOKEN})});
  let permalink='';
  for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,6000));
    try{ const st=await fbFetch(`${GRAPH}/${videoId}?fields=status,permalink_url&access_token=${encodeURIComponent(CFG.FB_PAGE_TOKEN)}`,{method:'GET'});
      const phase=st.status&&(st.status.video_status||(st.status.processing_phase&&st.status.processing_phase.status));
      if(st.permalink_url)permalink=st.permalink_url;
      if(phase==='ready'||phase==='PUBLISHED'||(st.status&&st.status.video_status==='ready'))break;
      if(phase==='error')throw new Error('FB xử lý lỗi: '+JSON.stringify(st.status)); }catch(e){}
  }
  if(permalink&&permalink.startsWith('/'))permalink='https://www.facebook.com'+permalink;
  return {videoId,permalink};
}
// Đăng comment #1 vào bài (link ebook). Cần FB scope pages_manage_engagement.
async function postComment(objectId, message) {
  return fbFetch(`${GRAPH}/${objectId}/comments`, { method:'POST', body:new URLSearchParams({ message, access_token:CFG.FB_PAGE_TOKEN }) });
}
async function updateRow(tk, recId, fields) {
  await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
    {method:'PUT',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify({fields})}, 'update');
}
function scheduleMs(cell){ const t=plain(cell).trim(); if(!t)return null;
  const m=t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); if(m)return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]).getTime();
  const d=new Date(t); return isNaN(d)?null:d.getTime(); }

(async()=>{
  const tk=await larkToken();
  const rows=await listAll(tk);
  const only=(process.env.RECORD_ID||'').trim();
  const base=only?rows.filter(r=>r.record_id===only):rows;
  const targets=base.filter(r=>selName(r.fields[F.trigger])===CFG.TRIGGER);
  log(`Tìm thấy ${targets.length} dòng "${CFG.TRIGGER}"${only?` (lọc RECORD_ID=${only})`:''} (tổng ${rows.length}).`);
  let ok=0,err=0,wait=0; const nowMs=Date.now();
  for(const row of targets){
    const recId=row.record_id;
    if(CFG.RESPECT_SCHEDULE){ const s=scheduleMs(row.fields[F.schedule]); if(s&&s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${plain(row.fields[F.schedule])}`); wait++; continue; } }
    const media=row.fields[F.media]; const att=Array.isArray(media)?(media.find(a=>/\.(mp4|mov|m4v|webm)$/i.test(a.name||''))||media[0]):null;
    const caption=[plain(row.fields[F.caption]),plain(row.fields[F.hashtag])].filter(Boolean).join('\n\n');
    if(!att||!att.file_token){ log(`  [BỎ QUA] ${recId}: không có file.`); if(!DRY)await updateRow(tk,recId,{[F.trigger]:'Lỗi',[F.log]:`${now()} - không có file`}); err++; continue; }
    log(`  >> ${recId}: ${(att.name||'').slice(0,40)} (${Math.round((att.size||0)/1048576*10)/10}MB)`);
    if(DRY){ log(`     [DRY] caption: ${caption.slice(0,60).replace(/\n/g,' ')}`);
      const c=plain(row.fields[F.comment]).trim(); if(c)log(`     [DRY] comment #1: ${c.slice(0,80).replace(/\n/g,' ')}`); continue; }
    const vp=path.join(os.tmpdir(),'reel_'+recId+'.mp4');
    try{ await downloadVideo(tk,att.file_token,vp);
      const {videoId,permalink}=await postReel(vp,caption);
      let cmtNote=''; const commentText=plain(row.fields[F.comment]).trim();
      if(commentText){ try{ await postComment(videoId,commentText); cmtNote=' +cmt'; }catch(e){ cmtNote=' (cmt lỗi: '+String(e.message||e).slice(0,80)+')'; log(`     ! comment lỗi: ${String(e.message||e).slice(0,120)}`); } }
      await updateRow(tk,recId,{[F.trigger]:'Đã đăng',[F.link]:permalink||'',[F.log]:`${now()} - OK - video_id ${videoId}${cmtNote}`});
      log(`     ✔ ĐÃ ĐĂNG: ${permalink||'(đang xử lý)'}`); ok++;
    }catch(e){ const msg=String(e.message||e).slice(0,300); log(`     ✖ LỖI: ${msg}`);
      try{await updateRow(tk,recId,{[F.trigger]:'Lỗi',[F.log]:`${now()} - ${msg}`});}catch{} err++;
    }finally{ try{fs.unlinkSync(vp)}catch{} }
  }
  log(`Xong. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}.`);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
