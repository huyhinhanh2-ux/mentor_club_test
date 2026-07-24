#!/usr/bin/env node
/*
 * mirror-fb-to-threads.js — TỰ ĐỘNG ĐĂNG CHÉO Facebook → Threads.
 *
 * SONG SINH với mirror-fb-to-ig.js. Cùng một triết lý: CEO chỉ điền bảng "14.3 Đăng bài
 * tự động", các nền tảng khác TỰ LẤY BÀI. Không nút mới, không bảng phải điền tay.
 *
 * Khi 1 bài ở 14.3 đã ĐĂNG FACEBOOK THÀNH CÔNG (và đúng loại + đúng Page), engine này
 * XẾP HÀNG bài đó sang bảng "23.3 Đăng bài Threads tự động". Việc đăng thật do
 * post-threads-api.js làm (đã chạy sẵn theo cron trong auto-dang-threads.yml).
 *
 * Engine này KHÔNG gọi Graph API. Nó chỉ làm 2 việc:
 *   (1) RECONCILE: đọc kết quả các bài đã xếp hàng lần trước (ở 23.3) rồi ghi ngược
 *       TH Trạng thái / TH Link / TH Log vào 14.3 (đóng vòng, chống đăng trùng).
 *   (2) ENQUEUE: tìm bài 14.3 đủ điều kiện CHƯA xử lý → tạo dòng 23.3, gán "Lịch đăng bài"
 *       theo luật giãn giờ, đánh dấu 14.3 để không xếp lại.
 *
 * ====================== LUẬT NGHIỆP VỤ (chốt với CEO 2026-07-25) ======================
 * • Phạm vi: CHỈ 2 Page — Bầu (BAU_PAGE_ID) và Newborn (NEWBORN_PAGE_ID). Page khác bỏ qua.
 * • Loại đủ điều kiện: GIỮ NGUYÊN luật 18/07 của Instagram — cột "Loại nội dung" bắt đầu
 *   bằng "reel…" HOẶC = "post ảnh sản phẩm". Các loại khác (mẹo hay / hậu trường /
 *   câu tương tác / câu chuyện dài) KHÔNG sang Threads.
 * • KHÁC INSTAGRAM MỘT ĐIỂM: bài TOÀN CHỮ vẫn đăng được (Threads cho phép, Instagram thì
 *   không) ⇒ không đòi phải có ảnh/video.
 * • Cả 2 Page đăng CHUNG 1 tài khoản Threads (TH_ACCOUNT_REC — dòng @thoministudio ở 23.2).
 * • Giãn giờ: MỌI bài cách nhau STAGGER_MINUTES phút, thứ tự **Bầu TRƯỚC, Newborn SAU**.
 *   Chuỗi giờ NỐI TIẾP các bài đã xếp ở lượt cron trước (đọc "Lịch đăng bài" trong 23.3),
 *   nên chạy cron 10 phút/lần cũng không bao giờ đăng chồng lên nhau.
 *   Chuỗi giờ này ĐỘC LẬP với chuỗi của Instagram — 2 nền tảng lên bài cùng lúc là bình thường.
 * • Bài đã đánh "Bỏ qua (bài cũ)" ở cột TH Trạng thái → không đụng tới.
 * =====================================================================================
 *
 * Đánh dấu chống trùng (song sinh với bộ cột IG):
 *   - Đủ điều kiện xử lý  ⇔  TH Trạng thái TRỐNG  VÀ  TH Log TRỐNG.
 *   - Sau khi xếp hàng   →  TH Log = "[queued] 23.3=<recId> due=<ISO> @<nowISO>".
 *   - Sau khi đăng xong  →  RECONCILE đọc dòng 23.3, set TH Trạng thái + TH Link + TH Log.
 *
 * ⚠️ HASHTAG: bảng 23.3 KHÔNG có cột Hastag, mà Threads chặn cứng 500 "ký tự" (emoji đếm
 *    theo byte UTF-8, xem thLen). Nên hashtag chỉ được nối vào cuối caption KHI CÒN CHỖ
 *    (≤ TH_SOFT_LIMIT). Không đủ chỗ thì BỎ hashtag và ghi rõ vào TH Log — thà mất hashtag
 *    còn hơn để post-threads-api phải gọi AI cắt gọt rồi ăn mất luôn phần nội dung.
 *
 * BIẾN MÔI TRƯỜNG:
 *   LARK_APP_ID, LARK_APP_SECRET, LARK_APP_TOKEN (=LARK_BASE_ID)     (bắt buộc)
 *   FB_POSTS_TABLE      = bảng 14.3  (nguồn)                          (bắt buộc)
 *   TH_POSTS_TABLE      = bảng 23.3  (hàng đợi Threads)               (bắt buộc)
 *   TH_ACCOUNTS_TABLE   = bảng 23.2  (để tự tìm tài khoản Threads)    (bắt buộc nếu không đặt TH_ACCOUNT_REC)
 * Tùy chọn:
 *   TH_ACCOUNT_REC      = record_id dòng tài khoản Threads ở 23.2 (mặc định: dòng đầu có Threads User ID)
 *   BAU_PAGE_ID         (mặc định 252437297948793)
 *   NEWBORN_PAGE_ID     (mặc định 107291022310921)
 *   STAGGER_MINUTES     (mặc định 30)
 *   MAX_ENQUEUE         (mặc định 20 — trần an toàn số bài xếp hàng mỗi lần chạy)
 *   TH_SOFT_LIMIT       (mặc định 450 — ngưỡng còn-chỗ để nối hashtag)
 *   LARK_DOMAIN         (mặc định https://open.larksuite.com)
 *
 * Chạy:  node scripts/mirror-fb-to-threads.js
 *        node scripts/mirror-fb-to-threads.js --dry-run   (chỉ in kế hoạch, KHÔNG ghi Base)
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:     process.env.LARK_APP_ID       || '',
  APP_SECRET: process.env.LARK_APP_SECRET   || '',
  APP_TOKEN:  process.env.LARK_APP_TOKEN    || '',
  FB_TABLE:   process.env.FB_POSTS_TABLE    || '',
  TH_TABLE:   process.env.TH_POSTS_TABLE    || '',
  ACC_TABLE:  process.env.TH_ACCOUNTS_TABLE || '',
  ACC_REC:    process.env.TH_ACCOUNT_REC    || '',
  BAU:        process.env.BAU_PAGE_ID       || '252437297948793',
  NEWBORN:    process.env.NEWBORN_PAGE_ID   || '107291022310921',
  STAGGER:    parseInt(process.env.STAGGER_MINUTES || '30', 10),
  MAX_ENQ:    parseInt(process.env.MAX_ENQUEUE     || '20', 10),
  SOFT_LIMIT: parseInt(process.env.TH_SOFT_LIMIT   || '450', 10),
  LARK_DOMAIN:process.env.LARK_DOMAIN       || 'https://open.larksuite.com',
};
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)     _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET) _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)  _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.FB_TABLE)   _miss.push('FB_POSTS_TABLE (bảng 14.3)');
if(!CFG.TH_TABLE)   _miss.push('TH_POSTS_TABLE (bảng 23.3)');
if(!CFG.ACC_TABLE && !CFG.ACC_REC) _miss.push('TH_ACCOUNTS_TABLE (bảng 23.2) hoặc TH_ACCOUNT_REC');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')); process.exit(1); }

// Cột 14.3 (nguồn Facebook)
const F14 = { page:'Page', loai:'Loại', loaiND:'Loại nội dung', loaiND2:'loại nội dung',
              caption:'Nội dung', hashtag:'Hastag', comment:'Comment ebook',
              media:'Ảnh/video', status:'Trạng thái', fanpageId:'Fanpage ID',
              thStatus:'TH Trạng thái', thLink:'TH Link', thLog:'TH Log' };
// Cột 23.3 (hàng đợi Threads)
const F23 = { link:'Tài khoản Threads', type:'Loại', caption:'Nội dung', comment:'Comment ebook',
              media:'Ảnh/video', schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const FB_DONE = 'Thành công';
const TH_DONE = 'Thành công', TH_FAIL = 'Thất bại';

const now   = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log   = (...a) => console.log(now(), ...a);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const isImg = a => /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name||'') || /^image/i.test(a.type||'');
// Threads đếm ký tự KHÔNG phải 1 char = 1. Emoji tính theo byte UTF-8. Sao y post-threads-api.js.
function thLen(s){ let n=0; for(const ch of s){ n += ch.codePointAt(0) >= 0x2000 ? Buffer.byteLength(ch,'utf8') : 1; } return n; }

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
// Tải media từ Lark rồi upload lại vào Base để lấy file_token dùng được cho dòng 23.3.
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
async function cloneAttachments(tk, atts){
  return atts.map(a=>({file_token:a.file_token}));   // thử tái dùng trước
}
async function reuploadAttachments(tk, atts){
  const out=[]; const tmp=[];
  try{
    for(let i=0;i<atts.length;i++){
      const a=atts[i];
      const p=path.join(os.tmpdir(), `mth_${i}_${(a.name||'m').replace(/[^\w.]/g,'')}`);
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
// Map loại media 14.3 → cột "Loại" bảng 23.3 (opts: Chữ | Hình ảnh | Video)
function th23Type(loai, loaiND, atts){
  if(!atts.length) return 'Chữ';
  const isReel = /video/i.test(loai) || (loaiND||'').toLowerCase().trim().startsWith('reel') || atts.some(isVid);
  return isReel ? 'Video' : 'Hình ảnh';
}
// Nối hashtag vào caption KHI CÒN CHỖ dưới trần mềm; hết chỗ thì bỏ, trả về ghi chú.
function captionForThreads(caption, tags){
  const base=(caption||'').trim();
  if(!tags) return { text:base, note:'' };
  const merged = base ? base+'\n\n'+tags : tags;
  if(thLen(merged) <= CFG.SOFT_LIMIT) return { text:merged, note:'' };
  return { text:base, note:`bỏ hashtag (sẽ vượt ${CFG.SOFT_LIMIT})` };
}

/* ================================ MAIN ================================ */
(async()=>{
  const tk=await larkToken();

  // Xác định tài khoản Threads dùng chung
  let accRec=CFG.ACC_REC;
  if(!accRec){
    const accs=await listAll(tk, CFG.ACC_TABLE);
    const withTh=accs.find(r=>plain(r.fields['Threads User ID']).trim());
    if(!withTh){ console.error('!! Bảng 23.2 chưa có tài khoản Threads nào có "Threads User ID".'); process.exit(1); }
    accRec=withTh.record_id;
    log(`Tài khoản Threads dùng chung: ${plain(withTh.fields['Username'])||accRec} (${accRec})`);
  }

  const fbRows=await listAll(tk, CFG.FB_TABLE);
  const T=Date.now();

  /* ---- (1) RECONCILE: đồng bộ kết quả Threads của lần xếp hàng trước về 14.3 ---- */
  let synced=0;
  for(const row of fbRows){
    const f=row.fields;
    if(plain(f[F14.thStatus]).trim()) continue;              // đã có kết luận Threads rồi
    const thLog=plain(f[F14.thLog]).trim();
    const m=thLog.match(/^\[queued\][^]*?23\.3=(\w+)/);
    if(!m) continue;
    const q23=m[1];
    let qr; try{ qr=await getRow(tk, CFG.TH_TABLE, q23); }catch{ continue; }
    const qs=plain(qr.fields[F23.status]).trim();
    if(qs===TH_DONE){
      const linkCell=qr.fields[F23.linkPost];
      const permalink=(linkCell&&(linkCell.link||plain(linkCell)))||'';
      if(!DRY) await updateRow(tk, CFG.FB_TABLE, row.record_id, {
        [F14.thStatus]:TH_DONE,
        ...(permalink?{[F14.thLink]:{link:permalink,text:'Xem Threads'}}:{}),
        [F14.thLog]:`[done] ${now()} - Threads: ${permalink||('23.3='+q23)}`,
      });
      synced++; log(`  ↩ SYNC 14.3 ${row.record_id} ← Threads OK (${permalink||q23})`);
    } else if(qs===TH_FAIL){
      if(!DRY) await updateRow(tk, CFG.FB_TABLE, row.record_id, {
        [F14.thStatus]:TH_FAIL,
        [F14.thLog]:`[fail] ${now()} - ${plain(qr.fields[F23.log]).slice(0,180)}`,
      });
      synced++; log(`  ↩ SYNC 14.3 ${row.record_id} ← Threads THẤT BẠI`);
    } // còn 'Chờ đăng'/chờ giờ → để nguyên, tick sau xử lý
  }

  /* ---- (2) ENQUEUE: tìm bài đủ điều kiện chưa xử lý ---- */
  const cand=[];
  for(const row of fbRows){
    const f=row.fields;
    if(plain(f[F14.status]).trim()!==FB_DONE) continue;             // chưa đăng FB thành công
    if(plain(f[F14.thStatus]).trim()) continue;                     // đã có kết luận/đánh dấu Threads
    if(plain(f[F14.thLog]).trim())    continue;                     // đã xếp hàng (có marker)
    const label=pageLabel(plain(f[F14.fanpageId]));
    if(!label) continue;                                            // ngoài phạm vi 2 Page
    const loaiND=plain(f[F14.loaiND])||plain(f[F14.loaiND2]);
    if(!eligibleType(loaiND)) continue;                             // sai loại
    const atts=Array.isArray(f[F14.media])?f[F14.media]:[];
    const caption=plain(f[F14.caption]).trim();
    if(!caption && !atts.length) continue;                          // rỗng hoàn toàn → không có gì để đăng
    cand.push({ row, label, atts, loaiND });
  }

  if(!cand.length){ log(`Xong. Sync: ${synced}. Không có bài mới đủ điều kiện để xếp hàng.`); return; }

  // Thứ tự: Bầu TRƯỚC, Newborn SAU (trong cùng nhóm giữ nguyên thứ tự bảng).
  cand.sort((a,b)=> (a.label==='bau'?0:1) - (b.label==='bau'?0:1));

  const STEP = CFG.STAGGER*60*1000;
  // Chuỗi giờ phải NỐI TIẾP các bài đã xếp/đăng gần đây trong 23.3 (chống đăng chồng giữa các lượt cron).
  const thRows = await listAll(tk, CFG.TH_TABLE);
  let lastSlot = null;
  for(const r of thRows){
    const s = r.fields[F23.schedule];
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
    const due = nextSlot; nextSlot += STEP;
    const tags=plain(f[F14.hashtag]).trim();
    const { text:caption, note:tagNote } = captionForThreads(plain(f[F14.caption]), tags);
    const cmt=plain(f[F14.comment]).trim();
    const type23=th23Type(plain(f[F14.loai]), c.loaiND, c.atts);

    log(`  >> [${c.label}] 14.3 ${c.row.record_id} | ${type23} | ${c.atts.length} file | ${thLen(caption)} ký tự Threads | due ${new Date(due).toISOString().slice(11,16)}${tagNote?' | '+tagNote:''} | "${caption.slice(0,34).replace(/\n/g,' ')}"`);
    if(DRY) continue;

    let mediaCells=await cloneAttachments(tk, c.atts);
    let rec23;
    const build = mc => ({
      [F23.link]:[accRec],
      [F23.type]:type23,
      [F23.caption]:caption,
      ...(cmt?{[F23.comment]:cmt}:{}),
      ...(mc.length?{[F23.media]:mc}:{}),
      [F23.schedule]:due,
      [F23.status]:'Chờ đăng',
    });
    try{
      rec23=await createRow(tk, CFG.TH_TABLE, build(mediaCells));
    }catch(e){
      if(!c.atts.length) throw e;                        // không phải lỗi media → ném tiếp
      log(`     … tái dùng file_token lỗi (${String(e.message||e).slice(0,60)}) → tải & upload lại`);
      mediaCells=await reuploadAttachments(tk, c.atts);
      rec23=await createRow(tk, CFG.TH_TABLE, build(mediaCells));
    }
    // đánh dấu 14.3 để không xếp lại
    await updateRow(tk, CFG.FB_TABLE, c.row.record_id, {
      [F14.thLog]:`[queued] ${now()} 23.3=${rec23} due=${new Date(due).toISOString()}${tagNote?' ('+tagNote+')':''} @${new Date(T).toISOString()}`,
    });
    enq++;
    log(`     ✔ xếp hàng 23.3=${rec23}`);
  }

  log(`Xong. Sync: ${synced}, Xếp hàng: ${enq}${cand.length>enq?`, còn ${cand.length-enq} chờ lần sau`:''}.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
