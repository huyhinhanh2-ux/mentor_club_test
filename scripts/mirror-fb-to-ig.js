#!/usr/bin/env node
/*
 * mirror-fb-to-ig.js — TỰ ĐỘNG ĐĂNG CHÉO Facebook → Instagram.
 *
 * Ý tưởng: khi 1 bài trong bảng "14.3 Đăng bài tự động" đã ĐĂNG FACEBOOK THÀNH CÔNG
 * (và đúng loại + đúng Page), thì lấy chính bài đó XẾP HÀNG sang bảng "22.2 Đăng bài
 * Instagram tự động" để engine post-instagram-api.js đăng lên IG.
 *
 * Engine này KHÔNG tự gọi Graph API — nó chỉ:
 *   (1) RECONCILE: đọc kết quả của các bài đã xếp hàng lần trước (ở 22.2) rồi ghi ngược
 *       IG Trạng thái / IG Link / IG Log vào 14.3 (đóng vòng, chống đăng trùng).
 *   (2) ENQUEUE: tìm bài 14.3 đủ điều kiện CHƯA xử lý → tạo dòng 22.2 (mượn caption + ảnh/video),
 *       gán "Lịch đăng bài" theo luật giãn giờ, đánh dấu 14.3 để không xếp lại.
 * Việc đăng thật do post-instagram-api.js làm (chạy NGAY SAU trong cùng workflow).
 *
 * ====================== LUẬT NGHIỆP VỤ (chốt với CEO 2026-07-18) ======================
 * • Phạm vi: CHỈ 2 Page — Bầu (BAU_PAGE_ID) và Newborn (NEWBORN_PAGE_ID). Page khác bỏ qua.
 * • Loại đủ điều kiện: cột "Loại nội dung" bắt đầu bằng "reel…" HOẶC = "post ảnh sản phẩm".
 * • Cả 2 Page đăng CHUNG 1 tài khoản IG (IG_ACCOUNT_REC — dòng @thoministudio ở 22.1).
 * • Giãn giờ: MỌI bài cách nhau đúng 30 phút (STAGGER_MINUTES), thứ tự **Bầu TRƯỚC, Newborn SAU**.
 *       Bài 1 đăng ngay, bài 2 sau 30', bài 3 sau 60'… (vd 1 Bầu + 1 Newborn → 10:00 và 10:30).
 *       Chuỗi giờ NỐI TIẾP cả các bài đã xếp ở lượt cron trước (đọc "Lịch đăng bài" trong 22.2),
 *       nên chạy cron 10 phút/lần cũng không bao giờ đăng chồng lên nhau.
 * • Bài cũ đã đánh "Bỏ qua (bài cũ)" ở cột IG Trạng thái → không đụng tới.
 * =====================================================================================
 *
 * Đánh dấu chống trùng (KHÔNG cần đổi schema 14.3):
 *   - Đủ điều kiện xử lý  ⇔  IG Trạng thái TRỐNG  VÀ  IG Log TRỐNG.
 *   - Sau khi xếp hàng   →  IG Log = "[queued] 22.2=<recId> due=<ISO> @<nowISO>" (IG Trạng thái vẫn trống).
 *   - Sau khi đăng xong  →  RECONCILE đọc dòng 22.2, set IG Trạng thái=Thành công/Thất bại + IG Link,
 *                            IG Log = "[done]/[fail] …".
 *
 * BIẾN MÔI TRƯỜNG:
 *   LARK_APP_ID, LARK_APP_SECRET, LARK_APP_TOKEN (=LARK_BASE_ID)     (bắt buộc)
 *   FB_POSTS_TABLE      = bảng 14.3  (nguồn)                          (bắt buộc)
 *   IG_POSTS_TABLE      = bảng 22.2  (hàng đợi IG)                    (bắt buộc)
 *   IG_ACCOUNTS_TABLE   = bảng 22.1  (để tự tìm tài khoản IG)         (bắt buộc nếu không đặt IG_ACCOUNT_REC)
 * Tùy chọn:
 *   IG_ACCOUNT_REC      = record_id dòng tài khoản IG ở 22.1 (mặc định: dòng đầu tiên có IG User ID)
 *   BAU_PAGE_ID         (mặc định 252437297948793)
 *   NEWBORN_PAGE_ID     (mặc định 107291022310921)
 *   STAGGER_MINUTES     (mặc định 30)
 *   MAX_ENQUEUE         (mặc định 20 — trần an toàn số bài xếp hàng mỗi lần chạy)
 *   LARK_DOMAIN         (mặc định https://open.larksuite.com)
 *
 * Chạy:  node scripts/mirror-fb-to-ig.js
 *        node scripts/mirror-fb-to-ig.js --dry-run   (chỉ in kế hoạch, KHÔNG ghi Base)
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:     process.env.LARK_APP_ID       || '',
  APP_SECRET: process.env.LARK_APP_SECRET   || '',
  APP_TOKEN:  process.env.LARK_APP_TOKEN    || '',
  FB_TABLE:   process.env.FB_POSTS_TABLE    || '',
  IG_TABLE:   process.env.IG_POSTS_TABLE    || '',
  ACC_TABLE:  process.env.IG_ACCOUNTS_TABLE || '',
  ACC_REC:    process.env.IG_ACCOUNT_REC    || '',
  BAU:        process.env.BAU_PAGE_ID       || '252437297948793',
  NEWBORN:    process.env.NEWBORN_PAGE_ID   || '107291022310921',
  STAGGER:    parseInt(process.env.STAGGER_MINUTES || '30', 10),
  MAX_ENQ:    parseInt(process.env.MAX_ENQUEUE     || '20', 10),
  LARK_DOMAIN:process.env.LARK_DOMAIN       || 'https://open.larksuite.com',
};
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)     _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET) _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)  _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.FB_TABLE)   _miss.push('FB_POSTS_TABLE (bảng 14.3)');
if(!CFG.IG_TABLE)   _miss.push('IG_POSTS_TABLE (bảng 22.2)');
if(!CFG.ACC_TABLE && !CFG.ACC_REC) _miss.push('IG_ACCOUNTS_TABLE (bảng 22.1) hoặc IG_ACCOUNT_REC');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')); process.exit(1); }

// Cột 14.3 (nguồn Facebook)
const F14 = { page:'Page', loai:'Loại', loaiND:'Loại nội dung', caption:'Nội dung', hashtag:'Hastag',
              media:'Ảnh/video', status:'Trạng thái', fanpageId:'Fanpage ID',
              igStatus:'IG Trạng thái', igLink:'IG Link', igLog:'IG Log' };
// Cột 22.2 (hàng đợi Instagram)
const F22 = { link:'Tài khoản IG', type:'Loại', caption:'Nội dung', hashtag:'Hastag',
              media:'Ảnh/video', schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const FB_DONE = 'Thành công';           // trạng thái đăng Facebook thành công
const IG_DONE = 'Thành công', IG_FAIL = 'Thất bại';

const now   = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log   = (...a) => console.log(now(), ...a);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const linkRecIds = cell => { if(!cell) return [];
  const arr=Array.isArray(cell)?cell:[cell]; let ids=[];
  for(const el of arr){ if(!el) continue;
    if(Array.isArray(el.record_ids)) ids=ids.concat(el.record_ids);
    else if(el.record_id) ids.push(el.record_id);
    else if(typeof el==='string') ids.push(el); }
  return ids.filter(Boolean); };
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const isImg = a => /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name||'') || /^image/i.test(a.type||'');

/* ---------- Lark (retry TooManyRequest 1254290) ---------- */
async function larkToken(){
  const r=await fetch(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET})});
  const j=await r.json(); if(j.code!==0) throw new Error('Lark token: '+JSON.stringify(j));
  return j.tenant_access_token;
}
async function larkCall(tk, url, opt={}, label=''){
  for(let i=0;i<6;i++){
    const r=await fetch(url,{headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json; charset=utf-8'},...opt});
    const j=await r.json();
    if(j.code===0) return j;
    if(j.code===1254290){ await sleep(1500*(i+1)); continue; }
    throw new Error(`${label}: ${j.msg} (code ${j.code})`);
  }
  throw new Error(`${label}: TooManyRequest quá nhiều lần`);
}
async function listAll(tk, tableId){
  let items=[], pt='';
  do{ const j=await larkCall(tk, `${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records?page_size=200`+(pt?'&page_token='+pt:''), {}, 'list '+tableId);
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; }while(pt);
  return items;
}
async function getRow(tk, tableId, recId){
  const j=await larkCall(tk, `${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records/${recId}`, {}, 'get '+recId);
  return j.data.record;
}
async function updateRow(tk, tableId, recId, fields){
  await larkCall(tk, `${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records/${recId}`,
    {method:'PUT', body:JSON.stringify({fields})}, 'update '+recId);
}
async function createRow(tk, tableId, fields){
  const j=await larkCall(tk, `${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records`,
    {method:'POST', body:JSON.stringify({fields})}, 'create');
  return j.data.record.record_id;
}
// Tải media từ Lark rồi upload lại vào Base để lấy file_token DÙNG ĐƯỢC cho dòng 22.2.
async function downloadMedia(tk, fileToken, out, tableId){
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for(const u of tries){ const r=await fetch(u,{headers:{Authorization:'Bearer '+tk}});
    if(r.ok && (r.headers.get('content-type')||'').indexOf('json')<0){
      const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được media từ Lark ('+fileToken+')');
}
async function uploadMedia(tk, filePath, fileName, isVideo){
  const buf=fs.readFileSync(filePath);
  const fd=new FormData();
  fd.set('file_name', fileName);
  fd.set('parent_type', isVideo?'bitable_file':'bitable_image');
  fd.set('parent_node', CFG.APP_TOKEN);
  fd.set('size', String(buf.length));
  fd.set('file', new Blob([buf]), fileName);
  const r=await fetch(`${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/upload_all`,{method:'POST',headers:{Authorization:'Bearer '+tk},body:fd});
  const j=await r.json();
  if(j.code!==0) throw new Error('upload_all lỗi: '+JSON.stringify(j));
  return j.data.file_token;
}
// Nhân bản attachment từ 14.3 sang 22.2: THỬ dùng lại file_token; nếu tạo dòng lỗi vì token → tải & upload lại.
async function cloneAttachments(tk, atts){
  return atts.map(a=>({file_token:a.file_token}));   // thử tái dùng trước
}
async function reuploadAttachments(tk, atts){
  const out=[]; const tmp=[];
  try{
    for(let i=0;i<atts.length;i++){
      const a=atts[i];
      const p=path.join(os.tmpdir(), `mir_${i}_${(a.name||'m').replace(/[^\w.]/g,'')}`);
      await downloadMedia(tk, a.file_token, p, CFG.FB_TABLE); tmp.push(p);
      const ft=await uploadMedia(tk, p, a.name||('media_'+i), isVid(a));
      out.push({file_token:ft});
    }
  } finally { tmp.forEach(p=>{ try{ fs.unlinkSync(p); }catch{} }); }
  return out;
}

/* ---------- Phân loại ---------- */
function eligibleType(loaiND){
  const l=(loaiND||'').toLowerCase().trim();
  if(!l) return false;
  return l.startsWith('reel') || (l.startsWith('post') && l.includes('sản phẩm'));
}
function pageLabel(fanpageId){
  const id=String(fanpageId||'').trim();
  if(id===CFG.BAU)     return 'bau';
  if(id===CFG.NEWBORN) return 'newborn';
  return null;
}
// Map loại media 14.3 → cột "Loại" bảng 22.2
function ig22Type(loai, loaiND, atts){
  const isReel = /video/i.test(loai) || (loaiND||'').toLowerCase().trim().startsWith('reel') || atts.some(isVid);
  if(isReel) return 'Video (Reels)';
  const imgs = atts.filter(a=>isImg(a)||!isVid(a));
  return imgs.length>1 ? 'Nhiều ảnh (Carousel)' : 'Hình ảnh';
}

/* ================================ MAIN ================================ */
(async()=>{
  const tk=await larkToken();

  // Xác định tài khoản IG dùng chung
  let accRec=CFG.ACC_REC;
  if(!accRec){
    const accs=await listAll(tk, CFG.ACC_TABLE);
    const withIg=accs.find(r=>plain(r.fields['IG User ID']).trim());
    if(!withIg){ console.error('!! Bảng 22.1 chưa có tài khoản IG nào có "IG User ID".'); process.exit(1); }
    accRec=withIg.record_id;
    log(`Tài khoản IG dùng chung: ${plain(withIg.fields['Username'])||accRec} (${accRec})`);
  }

  const fbRows=await listAll(tk, CFG.FB_TABLE);
  const T=Date.now();

  /* ---- (1) RECONCILE: đồng bộ kết quả IG của lần xếp hàng trước về 14.3 ---- */
  let synced=0;
  for(const row of fbRows){
    const f=row.fields;
    if(plain(f[F14.igStatus]).trim()) continue;              // đã có kết luận IG rồi
    const igLog=plain(f[F14.igLog]).trim();
    const m=igLog.match(/^\[queued\][^]*?22\.2=(\w+)/);
    if(!m) continue;
    const q22=m[1];
    let qr; try{ qr=await getRow(tk, CFG.IG_TABLE, q22); }catch{ continue; }
    const qs=plain(qr.fields[F22.status]).trim();
    if(qs===IG_DONE){
      const linkCell=qr.fields[F22.linkPost];
      const permalink=(linkCell&&(linkCell.link||plain(linkCell)))||'';
      if(!DRY) await updateRow(tk, CFG.FB_TABLE, row.record_id, {
        [F14.igStatus]:IG_DONE,
        ...(permalink?{[F14.igLink]:{link:permalink,text:'Xem IG'}}:{}),
        [F14.igLog]:`[done] ${now()} - IG: ${permalink||('22.2='+q22)}`,
      });
      synced++; log(`  ↩ SYNC 14.3 ${row.record_id} ← IG OK (${permalink||q22})`);
    } else if(qs===IG_FAIL){
      if(!DRY) await updateRow(tk, CFG.FB_TABLE, row.record_id, {
        [F14.igStatus]:IG_FAIL,
        [F14.igLog]:`[fail] ${now()} - ${plain(qr.fields[F22.log]).slice(0,180)}`,
      });
      synced++; log(`  ↩ SYNC 14.3 ${row.record_id} ← IG THẤT BẠI`);
    } // còn 'Chờ đăng'/chờ giờ → để nguyên, tick sau xử lý
  }

  /* ---- (2) ENQUEUE: tìm bài đủ điều kiện chưa xử lý ---- */
  const cand=[];
  for(const row of fbRows){
    const f=row.fields;
    if(plain(f[F14.status]).trim()!==FB_DONE) continue;             // chưa đăng FB thành công
    if(plain(f[F14.igStatus]).trim()) continue;                     // đã có kết luận/đánh dấu IG
    if(plain(f[F14.igLog]).trim())    continue;                     // đã xếp hàng (có marker)
    const label=pageLabel(plain(f[F14.fanpageId]));
    if(!label) continue;                                            // ngoài phạm vi 2 Page
    if(!eligibleType(plain(f[F14.loaiND]))) continue;               // sai loại
    const atts=Array.isArray(f[F14.media])?f[F14.media]:[];
    if(!atts.length) continue;                                      // IG không đăng bài toàn chữ
    cand.push({ row, label, atts });
  }

  if(!cand.length){ log(`Xong. Sync: ${synced}. Không có bài mới đủ điều kiện để xếp hàng.`); return; }

  // Thứ tự: Bầu TRƯỚC, Newborn SAU (trong cùng nhóm giữ nguyên thứ tự bảng).
  cand.sort((a,b)=> (a.label==='bau'?0:1) - (b.label==='bau'?0:1));

  const STEP = CFG.STAGGER*60*1000;
  // Chuỗi giờ phải NỐI TIẾP các bài đã xếp/đăng gần đây trong 22.2 (chống đăng chồng giữa các lượt cron).
  const igRows = await listAll(tk, CFG.IG_TABLE);
  let lastSlot = null;
  for(const r of igRows){
    const s = r.fields[F22.schedule];
    const ms = typeof s==='number' ? s : (s ? Date.parse(plain(s)) : NaN);
    if(!isNaN(ms) && ms >= T - STEP && (lastSlot===null || ms > lastSlot)) lastSlot = ms;
  }
  let nextSlot = (lastSlot!==null) ? lastSlot + STEP : T;
  if(nextSlot < T) nextSlot = T;

  log(`Ứng viên: ${cand.length} (Bầu ${cand.filter(c=>c.label==='bau').length}, Newborn ${cand.filter(c=>c.label==='newborn').length}). Giãn ${CFG.STAGGER}’/bài, Bầu trước. Slot đầu: ${new Date(nextSlot).toISOString().slice(11,16)}${lastSlot!==null?' (nối tiếp bài đã xếp)':''}.`);

  let enq=0;
  for(const c of cand){
    if(enq>=CFG.MAX_ENQ){ log(`  … dừng ở trần MAX_ENQUEUE=${CFG.MAX_ENQ}, phần còn lại để lần chạy sau.`); break; }
    const f=c.row.fields;
    // Luật giãn: mỗi bài một slot, cách nhau STAGGER phút (Bầu trước, Newborn sau).
    const due = nextSlot; nextSlot += STEP;
    const caption=plain(f[F14.caption]);
    const tags=plain(f[F14.hashtag]).trim();
    const type22=ig22Type(plain(f[F14.loai]), plain(f[F14.loaiND]), c.atts);

    log(`  >> [${c.label}] 14.3 ${c.row.record_id} | ${type22} | ${c.atts.length} file | due ${new Date(due).toISOString().slice(11,16)} | "${caption.slice(0,34).replace(/\n/g,' ')}"`);
    if(DRY) continue;

    // media: thử tái dùng file_token; nếu tạo dòng lỗi thì tải & upload lại
    let mediaCells=await cloneAttachments(tk, c.atts);
    let rec22;
    const build = mc => ({
      [F22.link]:[accRec],
      [F22.type]:type22,
      [F22.caption]:caption,
      ...(tags?{[F22.hashtag]:tags}:{}),
      [F22.media]:mc,
      [F22.schedule]:due,
      [F22.status]:'Chờ đăng',
    });
    try{
      rec22=await createRow(tk, CFG.IG_TABLE, build(mediaCells));
    }catch(e){
      log(`     … tái dùng file_token lỗi (${String(e.message||e).slice(0,60)}) → tải & upload lại`);
      mediaCells=await reuploadAttachments(tk, c.atts);
      rec22=await createRow(tk, CFG.IG_TABLE, build(mediaCells));
    }
    // đánh dấu 14.3 để không xếp lại
    await updateRow(tk, CFG.FB_TABLE, c.row.record_id, {
      [F14.igLog]:`[queued] ${now()} 22.2=${rec22} due=${new Date(due).toISOString()} @${new Date(T).toISOString()}`,
    });
    enq++;
    log(`     ✔ xếp hàng 22.2=${rec22}`);
  }

  log(`Xong. Sync: ${synced}, Xếp hàng: ${enq}${cand.length>enq?`, còn ${cand.length-enq} chờ lần sau`:''}.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
