#!/usr/bin/env node
/*
 * sync-dang-o-dau.js — GỘP báo cáo đa nền tảng vào MỘT cột "Đã đăng ở đâu" ở bảng 14.3.
 *
 * Ý tưởng (chốt với CEO 2026-07-27): thay vì kéo ngang xem 8 cột rải rác
 * (IG/TH/TikTok Trạng thái + Link + Log), gộp một cột NHÌN PHÁT BIẾT bài đã lan ra đâu:
 *
 *     FB ✅
 *     IG ✅ https://www.instagram.com/p/…
 *     TH ✅ https://www.threads.com/@…/post/…
 *     TikTok ✅
 *
 * • Instagram & Threads: KÈM link bài đăng (CEO yêu cầu). TikTok: KHÔNG kèm link
 *   (nháp Creator Inbox không có link công khai — không có gì để kèm).
 * • Chỉ tính dòng đã có kết luận Facebook (Trạng thái non-empty) — bài "Chờ đăng" để trống.
 * • CHỈ GHI khi giá trị THAY ĐỔI (so với cột hiện tại) ⇒ mỗi lượt cron chỉ ghi vài dòng,
 *   không nã 600 lệnh vào Lark (bài học TooManyRequest 26/07).
 * • Engine này KHÔNG tự đăng gì — chỉ đọc trạng thái sẵn có rồi gộp lại. Chạy CUỐI cùng
 *   trong mirror-ig.yml (sau khi IG/TH/TikTok đã ghi trạng thái của chúng).
 *
 * Ký hiệu:  ✅ Thành công · ❌ Thất bại · ➖ Bỏ qua (cố ý không mirror) · (rỗng) chưa xử lý.
 *
 * BIẾN MÔI TRƯỜNG: LARK_APP_ID, LARK_APP_SECRET, LARK_APP_TOKEN(=LARK_BASE_ID), FB_POSTS_TABLE.
 * Chạy:  node scripts/sync-dang-o-dau.js   ·   --dry-run (chỉ in, không ghi)
 */
'use strict';
const CFG = {
  APP_ID:     process.env.LARK_APP_ID     || '',
  APP_SECRET: process.env.LARK_APP_SECRET || '',
  APP_TOKEN:  process.env.LARK_APP_TOKEN  || '',
  FB_TABLE:   process.env.FB_POSTS_TABLE  || '',
  LARK_DOMAIN:process.env.LARK_DOMAIN     || 'https://open.larksuite.com',
};
const DRY = process.argv.includes('--dry-run');
const _m=[]; if(!CFG.APP_ID)_m.push('LARK_APP_ID'); if(!CFG.APP_SECRET)_m.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)_m.push('LARK_APP_TOKEN'); if(!CFG.FB_TABLE)_m.push('FB_POSTS_TABLE');
if(_m.length){ console.error('!! Thiếu biến: '+_m.join(', ')); process.exit(1); }

const COL = { fb:'Trạng thái', ig:'IG Trạng thái', igLink:'IG Link', th:'TH Trạng thái', thLink:'TH Link',
              tt:'TikTok Trạng thái', out:'Đã đăng ở đâu' };
const now=()=>new Date().toISOString().replace('T',' ').slice(0,19);
const log=(...a)=>console.log(now(),...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const plain=v=>v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const urlOf=cell=>{ if(!cell) return ''; if(cell.link) return cell.link;
  if(Array.isArray(cell)){ for(const el of cell){ if(el&&el.link) return el.link; const t=plain(el); if(/^https?:\/\//.test(t)) return t; } }
  const t=plain(cell); return /^https?:\/\//.test(t)?t:''; };

let _tk='';
async function larkApi(url,opt={},label=''){
  for(let i=0;i<6;i++){ let j;
    try{ const r=await fetch(url,{headers:{Authorization:'Bearer '+_tk,'Content-Type':'application/json; charset=utf-8'},...opt}); j=await r.json(); }
    catch(e){ if(i===5) throw new Error(label+': mạng '+e.message); await sleep(1500*(i+1)); continue; }
    if(j.code===0) return j;
    if(j.code===1254290){ await sleep(1500*(i+1)); continue; }
    throw new Error(`${label}: ${j.msg||JSON.stringify(j)} (code ${j.code})`);
  }
  throw new Error(label+': TooManyRequest quá nhiều lần');
}
async function larkToken(){
  const r=await fetch(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET})});
  const j=await r.json(); if(j.code!==0) throw new Error('token '+JSON.stringify(j)); return j.tenant_access_token;
}
async function listAll(){ let items=[],pt='';
  do{ const j=await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.FB_TABLE}/records?page_size=200`+(pt?'&page_token='+pt:''),{},'list');
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; }while(pt); return items; }
async function updateRow(rec,fields){ await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.FB_TABLE}/records/${rec}`,{method:'PUT',body:JSON.stringify({fields})},'update'); }

const sym = s => { const t=(s||'').trim();
  if(t==='Thành công') return '✅';
  if(t==='Thất bại')   return '❌';
  if(/^bỏ qua/i.test(t)) return '➖';
  return ''; };

function build(f){
  const fbS=sym(plain(f[COL.fb]));
  if(!fbS) return '';                                   // chưa có kết luận FB → để trống
  const lines=['FB '+fbS];
  const ig=sym(plain(f[COL.ig]));  if(ig){ let s='IG '+ig; if(ig==='✅'){ const u=urlOf(f[COL.igLink]); if(u) s+=' '+u; } lines.push(s); }
  const th=sym(plain(f[COL.th]));  if(th){ let s='TH '+th; if(th==='✅'){ const u=urlOf(f[COL.thLink]); if(u) s+=' '+u; } lines.push(s); }
  const tt=sym(plain(f[COL.tt]));  if(tt){ lines.push('TikTok '+tt); }   // TikTok: KHÔNG kèm link
  return lines.join('\n');
}

(async()=>{
  _tk=await larkToken();
  const rows=await listAll();
  let changed=0, scanned=0;
  for(const rec of rows){
    const f=rec.fields;
    const want=build(f);
    const cur=plain(f[COL.out]);
    if(want===cur) continue;                            // không đổi → bỏ qua (tiết kiệm ghi)
    scanned++;
    if(DRY){ if(scanned<=8) console.log('  ~',rec.record_id,'→',JSON.stringify(want).slice(0,90)); continue; }
    await updateRow(rec.record_id, { [COL.out]: want });
    changed++;
    if(changed%50===0) log('  …đã cập nhật',changed);
  }
  log(`Xong. Cập nhật "Đã đăng ở đâu": ${DRY?scanned+' (dry)':changed} dòng.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
