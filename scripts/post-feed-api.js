#!/usr/bin/env node
/*
 * post-feed-api.js — Đăng bài (ẢNH / VIDEO lên feed) từ bảng "Đăng bài" (Lark Base) lên Facebook Page.
 * MỖI DÒNG chọn Page riêng qua cột link (trỏ tới bảng Pages) → dùng đúng token của page đó.
 *
 * Chạy:  node scripts/post-feed-api.js            (đăng thật các dòng đủ điều kiện)
 *        node scripts/post-feed-api.js --dry-run  (chỉ liệt kê, không đăng, không ghi Base)
 *
 * Điều kiện đăng 1 dòng: Trạng thái ≠ "Thành công" + có Page link + có file Ảnh/video
 *   + (Lịch đăng bài trống hoặc đã tới giờ). Đăng xong set Trạng thái + Log + Link bài đăng.
 *
 * ⚠️ Đăng THEO LÔ: engine quét TẤT CẢ dòng đủ điều kiện (bỏ qua dòng đã "Thành công"),
 *    không chỉ dòng vừa bấm nút. Bấm lại chỉ đăng các dòng chưa đăng.
 *
 * CẤU HÌNH qua BIẾN MÔI TRƯỜNG (không hardcode — thiếu là báo lỗi, không chạy nhầm Base):
 *   LARK_APP_ID       (bắt buộc)  — App ID Lark (cli_...)
 *   LARK_APP_SECRET   (bắt buộc)  — App Secret Lark
 *   LARK_APP_TOKEN    (bắt buộc)  — Base ID/token (phần sau /base/ trong URL) = GitHub Variable LARK_BASE_ID
 *   LARK_TABLE_ID     (bắt buộc)  — mã bảng Đăng bài (tbl...)               = GitHub Variable TABLE_DANGBAI
 *   PAGES_TABLE_ID    (bắt buộc)  — mã bảng Pages (tbl...)                  = GitHub Variable TABLE_PAGES
 * Tùy chọn: LARK_DOMAIN, GRAPH_VERSION, RESPECT_SCHEDULE (đặt "false" để bỏ qua Lịch đăng).
 * Giữ nhịp (xem khối GIỮ ĐÚNG GIỜ, KHÔNG ĐĂNG DỒN bên dưới):
 *   GRACE_MINUTES     (mặc định 90)  — trễ hơn bấy nhiêu phút thì thôi, không đăng lệch khung giờ
 *   MAX_FAIL          (mặc định 3)   — hỏng đủ bấy nhiêu lần thì ngưng thử lại
 *   MAX_VIDEO_MB      (mặc định 2048) — lưới an toàn cuối, chặn file to bất thường
 *   MOT_BAI_MOI_PAGE  ("false" để tắt) — mỗi lượt chạy, mỗi page chỉ đăng 1 bài
 *   VIDEO_MOT_PHAT_MB (mặc định 50) — video dưới cỡ này đẩy một phát; trên thì
 *                                     upload nhiều chặng (xem postVideo)
 * Token Facebook lấy TỪ bảng Pages (cột access_token) — không cần env FB.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
// Ghép nhiều ảnh thành MỘT trang dàn ảnh trước khi đăng, để Facebook không tự cắt collage.
// Tự tắt (trả về nguyên danh sách ảnh) khi thiếu Chrome hoặc PHOTOBOOK=false → không bao giờ chặn lượt đăng.
const photobook = require('./photobook.js');
const CFG = {
  APP_ID:       process.env.LARK_APP_ID    || '',
  APP_SECRET:   process.env.LARK_APP_SECRET|| '',
  APP_TOKEN:    process.env.LARK_APP_TOKEN || '',   // = GitHub Variable LARK_BASE_ID (base token)
  TABLE_ID:     process.env.LARK_TABLE_ID  || '',   // = GitHub Variable TABLE_DANGBAI
  PAGES_TABLE:  process.env.PAGES_TABLE_ID || '',   // = GitHub Variable TABLE_PAGES
  LARK_DOMAIN:  process.env.LARK_DOMAIN    || 'https://open.larksuite.com',
  GRAPH_VERSION:process.env.GRAPH_VERSION  || 'v21.0',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false',
  // ── Ba con số giữ nhịp đăng (xem khối GIỮ ĐÚNG GIỜ, KHÔNG ĐĂNG DỒN bên dưới) ──
  GRACE_MIN:    +(process.env.GRACE_MINUTES  || 90),   // trễ quá bấy nhiêu phút thì THÔI, không đăng lệch khung giờ
  MAX_FAIL:     +(process.env.MAX_FAIL       || 3),    // thất bại đủ bấy nhiêu lần thì ngưng, không thử lại nữa
  MAX_VIDEO_MB: +(process.env.MAX_VIDEO_MB   || 2048), // lưới an toàn cuối: file to bất thường thì chặn, kẻo nạp nhầm
  MOT_BAI_MOI_PAGE: process.env.MOT_BAI_MOI_PAGE !== 'false',  // mỗi lượt chạy, mỗi page chỉ đăng 1 bài
};
const GRAPH = `https://graph.facebook.com/${CFG.GRAPH_VERSION}`;
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)      _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET)  _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)   _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.TABLE_ID)    _miss.push('LARK_TABLE_ID (=TABLE_DANGBAI)');
if(!CFG.PAGES_TABLE) _miss.push('PAGES_TABLE_ID (=TABLE_PAGES)');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')+'\n   → khai trong GitHub Secrets/Variables (xem README).'); process.exit(1); }

const F = { link:'Link Page', type:'Loại', caption:'Nội dung', comment:'Comment ebook', media:'Ảnh/video',
            schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const DONE = 'Thành công', FAIL = 'Thất bại';

// ── CHỐNG ĐĂNG TRÙNG ────────────────────────────────────────────────────────
// Sự cố thật (2026-07-28, page Bầu + page Newborn): một dòng trong bảng lên
// Facebook HAI BÀI giống hệt, cùng giờ. Bảng chỉ có đúng một dòng — nên không
// phải lỗi dữ liệu, mà là hai lượt chạy cùng xử lý một dòng.
//
// Vì sao dính: bản cũ chỉ ghi "Thành công" SAU KHI đăng xong. Từ lúc đọc thấy
// dòng còn "Chờ đăng" tới lúc ghi trạng thái là cả quãng tải ảnh về + đẩy lên
// Facebook — dài hàng chục giây tới vài phút. Trong quãng đó, lượt chạy thứ hai
// (cron 15 phút, hoặc người bấm nút) đọc vẫn thấy "Chờ đăng" ⇒ đăng lần nữa.
//
// Sửa: GIÀNH CHỖ TRƯỚC KHI ĐĂNG. Ghi ngay một dấu "ĐANG ĐĂNG (<mã lượt chạy>)"
// vào cột Log, rồi ĐỌC LẠI xem dấu còn là của mình không. Không phải của mình
// ⇒ lượt khác giành trước ⇒ nhường. Cách này thu cửa sổ tranh chấp từ vài phút
// xuống còn khoảng một giây, và cửa sổ đó lại được `concurrency` chặn nốt.
//
// Cố ý đánh dấu vào LOG chứ không thêm lựa chọn "Đang đăng" vào cột Trạng thái:
// sửa cột select trên Lark là ghi đè TOÀN BỘ định nghĩa cột (không phải vá từng
// phần), làm hỏng là hỏng cả cột đang gánh mấy trăm dòng. Log là cột text tự do,
// ghi vào không rủi ro gì, mà vẫn nhìn thấy được trên giao diện.
//
// Dòng kẹt dấu ĐANG ĐĂNG (lượt chạy chết giữa chừng) được nhả sau CLAIM_TTL để
// không kẹt vĩnh viễn.
// ── GIỮ ĐÚNG GIỜ, KHÔNG ĐĂNG DỒN ───────────────────────────────────────────
// Sự cố thật (11/08/2026, page Bầu): 4 video hẹn 10/08 18:00 · 11/08 08:00 ·
// 12:00 · 18:00 cùng lên sóng trong 2 phút 16 giây lúc 21:31–21:34 tối. Bài ẢNH
// cùng ngày lên đúng giờ, chỉ VIDEO bị dồn.
//
// Chuỗi nhân quả (dò từ record-history của Lark):
//   4 video nặng 148–170MB → Facebook trả 413 Payload Too Large
//   → engine cũ chỉ bỏ qua dòng "Thành công", nên dòng "Thất bại" bị thử lại
//     VÔ HẠN mỗi 15 phút suốt 9 ngày (~3.400 lần đẩy file 150MB)
//   → Facebook đếm cả lần hỏng vào hạn mức tần suất của Page ⇒ bật chống spam
//     ("Để bảo vệ cộng đồng khỏi spam, chúng tôi giới hạn tần suất bạn đăng bài")
//   → video HỢP LỆ theo lịch bị đá ra suốt cả ngày, nằm dồn kho
//   → 21:31 Facebook hạ chặn ⇒ cả kho xả một lượt.
//
// Bốn chốt chặn, mỗi chốt cắt một mắt xích:
//   ① QUÁ HẠN  — trễ hơn GRACE_MIN phút thì KHÔNG đăng nữa. Bài hẹn 8h sáng
//                không bao giờ tự nhảy ra lúc 9h30 tối. Đây là chốt trả lại
//                đúng nghĩa cho cột "Lịch đăng bài".
//   ② NGƯNG    — thất bại đủ MAX_FAIL lần thì thôi. Hết cảnh một video hỏng
//                đập cửa Facebook mãi mãi rồi kéo cả hệ vào diện nghi spam.
//   ③ CHẶN NẶNG— video quá MAX_VIDEO_MB bị chặn TRƯỚC khi tải về, không tốn
//                một lần gọi Facebook nào. Từ 12/08 đây chỉ còn là LƯỚI AN TOÀN
//                CUỐI (trần 2GB, phòng nạp nhầm file khổng lồ) — video nặng đã
//                đăng được thật nhờ upload nhiều chặng, xem postVideo() bên dưới.
//   ④ GIÃN NHỊP— mỗi lượt chạy, mỗi page chỉ đăng 1 bài. Cron 15 phút ⇒ hai bài
//                cùng page luôn cách nhau ít nhất 15 phút, không bao giờ dính
//                chùm. (Engine Instagram đã giãn 30 phút từ commit 8ae37ae.)
//
// Cả 4 chốt đều được BỎ QUA khi chạy một dòng cụ thể qua RECORD_ID (người dùng
// bấm nút "Đăng") — bấm nút là ý muốn rõ ràng của con người, engine không cãi.
// Đó cũng là cách gỡ dấu NGƯNG cho một dòng: sửa file rồi bấm nút.
// ── PAGE BỊ FACEBOOK KHOÁ ĐĂNG VIDEO ───────────────────────────────────────
// Chuyện thật, kéo dài 17 ngày mà không ai biết (11/08 → 28/08/2026): page Bầu
// đăng ẢNH vẫn bình thường nhưng mọi VIDEO đều trượt. Đo tay mới ra: Facebook
// trả code 368 / subcode 1390008 — mã của "tạm khoá vì vi phạm chính sách",
// KHÔNG phải nghẽn tần suất, dù lời văn nói y như nghẽn tần suất. Cùng file đó
// đẩy sang page Newborn thì lên ngay ⇒ không phải lỗi engine, lỗi file hay token.
// Cả hai đường /videos và /video_reels đều bị chặn ⇒ khoá áp cho cả tính năng
// video của page, không có đường vòng nào.
//
// Với mã này, thử lại là VÔ ÍCH và có hại — mỗi lần thử là thêm một lần Facebook
// thấy hành vi lặp, có thể kéo dài thời gian khoá. Nên:
//   · Page nào trả 368 thì CẢ LƯỢT CHẠY không đụng tới video của page đó nữa.
//   · Lỗi này KHÔNG tính vào bộ đếm NGƯNG — nó không phải lỗi của dòng bài. Ngày
//     Facebook mở khoá, dòng phải tự đăng được mà không cần ai bấm gì.
const KHOA_CHINH_SACH = 368;
const laKhoaChinhSach = e => e && (e.fbCode === KHOA_CHINH_SACH || e.fbSub === 1390008);
const NHAN_KHOA = '[FB KHOÁ VIDEO 368]';

const NGUNG = '[NGƯNG]';
const QUA_HAN = '[QUÁ HẠN]';
const FAIL_RE = /\[thử (\d+)\/\d+\]/;
const demThu = t => +(String(t||'').match(FAIL_RE)||[])[1] || 0;
// Hậu tố đánh vào Log mỗi lần đăng hỏng; chạm trần thì đóng dấu NGƯNG luôn.
function dauLanThu(logCu){
  const n = demThu(logCu) + 1;
  return ` [thử ${n}/${CFG.MAX_FAIL}]` + (n >= CFG.MAX_FAIL ? ` ${NGUNG}` : '');
}

const CLAIM_TTL_MS = 20 * 60 * 1000;
const RUN_TAG = process.env.GITHUB_RUN_ID
  ? `run${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT || 1}`
  : `local${process.pid}.${Date.now().toString(36)}`;
const CLAIM_RE = /ĐANG ĐĂNG \(([^)]+)\)/;

// Dòng Log lúc giành chỗ — có cả giờ để biết claim cũ đã thiu chưa.
// Mang theo dấu [thử n/N] của log cũ, kẻo ghi đè xong là mất số lần đã thử.
const claimLine = (logCu) => {
  const m = String(logCu||'').match(FAIL_RE);
  return `${now()} - ĐANG ĐĂNG (${RUN_TAG})` + (m ? ` ${m[0]}` : '');
};

// Claim này còn hiệu lực không? (còn hạn = lượt khác đang làm thật, phải nhường)
function claimConHan(logText) {
  const m = String(logText || '').match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - ĐANG ĐĂNG/);
  if (!m) return false;
  const t = Date.parse(m[1].replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && (Date.now() - t) < CLAIM_TTL_MS;
}
const now = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log = (...a) => console.log(now(), ...a);
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const isImg = a => /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name||'') || /^image/i.test(a.type||'');
// Lấy record_ids từ cell link — API list trả MẢNG [{record_ids:[...]}], API 1-record trả OBJECT {record_ids:[...]}.
const linkRecIds = cell => { if(!cell) return [];
  const arr = Array.isArray(cell) ? cell : [cell]; let ids=[];
  for(const el of arr){ if(!el) continue;
    if(Array.isArray(el.record_ids)) ids=ids.concat(el.record_ids);
    else if(el.record_id) ids.push(el.record_id);
    else if(typeof el==='string') ids.push(el); }
  return ids.filter(Boolean); };

const sleep = ms => new Promise(r=>setTimeout(r,ms));
/* Bọc MỌI lời gọi Lark: tự chờ rồi thử lại khi dính TooManyRequest (1254290) hoặc lỗi mạng.
 * ⚠️ TRƯỚC ĐÂY THIẾU LỚP NÀY nên chỉ cần Lark chặn 1 nhịp là workflow chết FATAL — gặp thật
 * 26/07/2026: cron Cloudflare bắn đều 3 workflow cách nhau 4', cùng quét bảng 632 dòng, đụng
 * trần QPS của Lark ⇒ `FATAL list tblC80uwemNeY9s1: TooManyRequest`, bài Facebook không lên.
 * Hai engine mirror đã có retry này từ đầu; post-feed là mắt xích yếu duy nhất còn sót. */
async function larkApi(url, opt={}, label='') {
  for (let i=0; i<6; i++) {
    let j;
    try { const r=await fetch(url, opt); j=await r.json(); }
    catch (netErr) {                                   // lỗi mạng/parse → chờ rồi thử lại
      if (i===5) throw new Error(`${label}: lỗi mạng sau 6 lần — ${netErr.message}`);
      await sleep(1500*(i+1)); continue;
    }
    if (j.code === 0) return j;
    if (j.code === 1254290) { await sleep(1500*(i+1)); continue; }   // TooManyRequest → backoff tăng dần
    throw new Error(`${label}: ${j.msg||JSON.stringify(j)} (code ${j.code})`);   // lỗi nghiệp vụ khác → ném luôn
  }
  throw new Error(`${label}: TooManyRequest quá nhiều lần`);
}
async function larkToken() {
  const j = await larkApi(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET}) }, 'token');
  if (!j.tenant_access_token) throw new Error('Lark token: '+JSON.stringify(j));
  return j.tenant_access_token;
}
async function listAll(tk, tableId) {
  let items=[], pt='';
  do { const j=await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records?page_size=200`+(pt?'&page_token='+pt:''),{headers:{Authorization:'Bearer '+tk}}, 'list '+tableId);
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; } while(pt);
  return items;
}
async function listFields(tk, tableId) {
  const j=await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/fields?page_size=200`,{headers:{Authorization:'Bearer '+tk}}, 'fields');
  return (j.data.items||[]).map(f=>({name:f.field_name,type:f.type}));
}
async function updateRow(tk, recId, fields) {
  await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
    {method:'PUT',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+tk},body:JSON.stringify({fields})}, 'update');
}
async function downloadMedia(tk, fileToken, out) {
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:CFG.TABLE_ID}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for (const u of tries) { const r=await fetch(u,{headers:{Authorization:'Bearer '+tk}});
    if (r.ok && (r.headers.get('content-type')||'').indexOf('json')<0) { const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được media từ Lark');
}
// ⚠️ MÃ LỖI PHẢI ĐỨNG ĐẦU THÔNG ĐIỆP. Bản cũ ném ra 'FB 400: {"message":"Để bảo
// vệ cộng đồng khỏi spam..."}' — cột Log lại cắt ở 200 ký tự, mà `code` nằm SAU
// `message` trong JSON của Facebook ⇒ mã bị cắt mất. Hậu quả thật: từ 11/08 đến
// 28/08/2026, page Bầu bị Facebook KHOÁ TÍNH NĂNG VIDEO (code 368) suốt 17 ngày
// mà trong Log chỉ đọc được câu "giới hạn tần suất, thử lại sau" — nghe như nghẽn
// nhất thời nên không ai đi tìm, trong khi 368 là chuyện hoàn toàn khác và phải
// xử lý bằng tay trên Facebook. Nay mã đứng trước, có cắt cũng không mất.
async function fbFetch(u,o){ const r=await fetch(u,o); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
  if(!r.ok||j.error){
    const e0=j.error||{};
    const ma=e0.code!=null ? `code ${e0.code}${e0.error_subcode!=null?'/'+e0.error_subcode:''}` : 'không rõ mã';
    const err=new Error(`FB ${r.status} (${ma}): ${e0.message||JSON.stringify(j._raw||j).slice(0,200)}`);
    err.fbCode=e0.code; err.fbSub=e0.error_subcode;
    throw err;
  }
  return j; }

// Đăng feed ảnh: 1 ảnh → /photos (published mặc định=true, hiện thẳng feed công khai).
// Nhiều ảnh → upload từng ảnh (published=false) → media_fbid → tạo post /feed đính kèm.
async function postPhotos(pageId, token, files, caption) {
  if (files.length === 1) {
    const f=files[0]; const fd=new FormData(); fd.set('access_token',token); if(caption)fd.set('caption',caption);
    fd.set('source', new Blob([fs.readFileSync(f.path)]), f.name||'photo.jpg');
    const j=await fbFetch(`${GRAPH}/${pageId}/photos`,{method:'POST',body:fd});
    if(!j.id&&!j.post_id) throw new Error('upload ảnh không có id');
    const objectId=j.post_id||j.id;
    let permalink=`https://www.facebook.com/${objectId}`;
    try{ const st=await fbFetch(`${GRAPH}/${objectId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
      if(st.permalink_url) permalink=st.permalink_url.startsWith('/')?'https://www.facebook.com'+st.permalink_url:st.permalink_url; }catch{}
    return { objectId, permalink };
  }
  const fbids=[];
  for (const f of files) {
    const fd=new FormData(); fd.set('access_token',token); fd.set('published','false');
    fd.set('source', new Blob([fs.readFileSync(f.path)]), f.name||'photo.jpg');
    const j=await fbFetch(`${GRAPH}/${pageId}/photos`,{method:'POST',body:fd});
    if(!j.id) throw new Error('upload ảnh không có id'); fbids.push(j.id);
  }
  const body=new URLSearchParams(); body.set('access_token',token); if(caption)body.set('message',caption);
  fbids.forEach((id,i)=>body.set(`attached_media[${i}]`, JSON.stringify({media_fbid:id})));
  const post=await fbFetch(`${GRAPH}/${pageId}/feed`,{method:'POST',body});
  // Lấy permalink THẬT (facebook.com/{actor}/posts/{id}). Link facebook.com/{pageID}_{postID}
  // với Page "trải nghiệm mới" KHÔNG mở được cho người ngoài/chưa đăng nhập → tưởng bài bị ẩn.
  let permalink=`https://www.facebook.com/${post.id}`;
  try{ const st=await fbFetch(`${GRAPH}/${post.id}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
    if(st.permalink_url) permalink=st.permalink_url.startsWith('/')?'https://www.facebook.com'+st.permalink_url:st.permalink_url; }catch{}
  return { objectId:post.id, permalink };
}
// ── ĐĂNG VIDEO NẶNG: UPLOAD NHIỀU CHẶNG ────────────────────────────────────
// Đẩy nguyên khối (một request mang cả file) là cách cũ, và Facebook chặn ở
// khoảng 100MB — trả về 413 Payload Too Large với thân rỗng, không một chữ giải
// thích. Đó là thứ đã giết 4 video 148–170MB suốt 9 ngày (xem sự cố 11/08).
//
// Facebook có sẵn đường cho file lớn, đi ba chặng:
//   start    → khai trước kích thước file, nhận về video_id + upload_session_id
//              + khoảng byte đầu tiên cần gửi (start_offset → end_offset)
//   transfer → gửi đúng khoảng byte đó; đáp lại là khoảng tiếp theo. Lặp tới khi
//              hai đầu khoảng bằng nhau là hết file.
//   finish   → chốt phiên, gắn caption, bài lên sóng.
//
// Hai điều đáng giá của cách này:
//   · KHÔNG nạp cả file vào RAM — đọc đúng đoạn đang gửi bằng fs.readSync, nên
//     video 2GB cũng chỉ tốn vài MB bộ nhớ.
//   · Mảnh nào rớt mạng thì gửi LẠI ĐÚNG MẢNH ĐÓ, không phải làm lại từ đầu —
//     đúng nghĩa "resumable". Với file trăm MB trên runner CI, đây là khác biệt
//     giữa "đăng được" và "thỉnh thoảng hỏng lại phải chờ lượt sau".
//
// Video nhỏ vẫn đi đường cũ (một request, nhanh hơn, ít lần gọi API hơn).
const NGUONG_PHAN_MANH = (+(process.env.VIDEO_MOT_PHAT_MB || 50)) * 1048576;

async function uploadVideoNhieuChang(pageId, token, file, log) {
  const size = fs.statSync(file.path).size;
  const start = await fbFetch(`${GRAPH}/${pageId}/videos`, { method:'POST',
    body:new URLSearchParams({ upload_phase:'start', file_size:String(size), access_token:token }) });
  const sess = start.upload_session_id, videoId = start.video_id;
  if(!sess || !videoId) throw new Error('start thiếu upload_session_id/video_id: '+JSON.stringify(start));

  let from = +start.start_offset, to = +start.end_offset;
  const fd = fs.openSync(file.path, 'r');
  let manh = 0;
  try {
    while (from < to) {
      const len = to - from;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, from);          // đọc đúng đoạn đang gửi, không nạp cả file
      let dap;
      for (let i=0;;i++) {                          // rớt mảnh nào thì gửi lại đúng mảnh đó
        try {
          const form = new FormData();
          form.set('upload_phase','transfer'); form.set('upload_session_id',sess);
          form.set('start_offset',String(from));   form.set('access_token',token);
          form.set('video_file_chunk', new Blob([buf]), file.name||'video.mp4');
          dap = await fbFetch(`${GRAPH}/${pageId}/videos`, { method:'POST', body:form });
          break;
        } catch(e) {
          if (i>=2) throw new Error(`mảnh tại byte ${from} hỏng sau 3 lần: ${String(e.message||e).slice(0,150)}`);
          await sleep(2000*(i+1));
        }
      }
      manh++;
      if (log && manh % 5 === 0) log(`     … đã đẩy ${(from/1048576).toFixed(0)}/${(size/1048576).toFixed(0)}MB`);
      from = +dap.start_offset; to = +dap.end_offset;
    }
  } finally { try{ fs.closeSync(fd); }catch{} }
  if (log) log(`     … xong ${manh} mảnh (${(size/1048576).toFixed(1)}MB)`);
  return { videoId, sess };
}

async function postVideo(pageId, token, file, caption) {
  const size = fs.statSync(file.path).size;
  if (size > NGUONG_PHAN_MANH) {
    const { videoId, sess } = await uploadVideoNhieuChang(pageId, token, file, log);
    await fbFetch(`${GRAPH}/${pageId}/videos`, { method:'POST',
      body:new URLSearchParams({ upload_phase:'finish', upload_session_id:sess,
        ...(caption?{description:caption}:{}), access_token:token }) });
    let permalink='';
    try{ const st=await fbFetch(`${GRAPH}/${videoId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
      permalink=st.permalink_url||''; }catch{}
    if(permalink&&permalink.startsWith('/'))permalink='https://www.facebook.com'+permalink;
    return { objectId:videoId, permalink:permalink||`https://www.facebook.com/${videoId}` };
  }
  const fd=new FormData(); fd.set('access_token',token); if(caption)fd.set('description',caption);
  fd.set('source', new Blob([fs.readFileSync(file.path)]), file.name||'video.mp4');
  const j=await fbFetch(`${GRAPH}/${pageId}/videos`,{method:'POST',body:fd});
  if(!j.id) throw new Error('upload video không có id');
  let permalink='';
  try{ const st=await fbFetch(`${GRAPH}/${j.id}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,{method:'GET'});
    permalink=st.permalink_url||''; }catch{}
  if(permalink&&permalink.startsWith('/'))permalink='https://www.facebook.com'+permalink;
  return { objectId:j.id, permalink:permalink||`https://www.facebook.com/${j.id}` };
}
async function postComment(pageId, token, objectId, message){
  return fbFetch(`${GRAPH}/${objectId}/comments`,{method:'POST',body:new URLSearchParams({message,access_token:token})});
}
function scheduleMs(cell){ if(cell==null)return null; if(typeof cell==='number')return cell; // Lark datetime = epoch ms
  const t=plain(cell).trim(); if(!t)return null;
  const m=t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); if(m)return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]).getTime();
  const d=new Date(t); return isNaN(d)?null:d.getTime(); }

// Mở cửa cho kiểm thử: `require` file này thì KHÔNG chạy vòng đăng, chỉ lấy hàm.
// Nhờ vậy kiểm được luồng upload nhiều chặng bằng chính hàm thật (chạy start +
// transfer rồi DỪNG, không finish ⇒ không bài nào lên sóng), thay vì chép tay
// một bản mô phỏng rồi đinh ninh là giống.
module.exports = { uploadVideoNhieuChang, postVideo, fbFetch, laKhoaChinhSach, larkToken, listAll, downloadMedia, plain, NGUONG_PHAN_MANH };
if (require.main !== module) return;

(async()=>{
  const tk=await larkToken();
  // Tự dò cột link tới bảng Pages (type 18 single-link / 21 duplex-link) — không phụ thuộc tên cột.
  try {
    const flds=await listFields(tk, CFG.TABLE_ID);
    const lf=flds.find(f=>f.type===18||f.type===21) || flds.find(f=>/page/i.test(f.name));
    if(lf) F.link=lf.name;
    log(`Cột link Page = "${F.link}".`);
  } catch(e){ log('! không đọc được fields, dùng mặc định "'+F.link+'": '+String(e.message||e)); }
  // map record_id (bảng Pages) -> {fbId, token, name}
  const pageRecs=await listAll(tk, CFG.PAGES_TABLE);
  const pageMap=new Map();
  for(const r of pageRecs){ pageMap.set(r.record_id, { fbId:plain(r.fields.ID).trim(), token:plain(r.fields.access_token).trim(), name:plain(r.fields.Fanpage).trim() }); }

  const rows=await listAll(tk, CFG.TABLE_ID);
  // Nếu Automation gửi RECORD_ID (dòng vừa bấm nút) → chỉ xử lý đúng dòng đó; trống → quét cả bảng.
  const only=(process.env.RECORD_ID||'').trim();
  // Xếp theo giờ hẹn tăng dần: bài tới hạn sớm nhất được ưu tiên suất đăng của lượt này.
  const scan=(only?rows.filter(r=>r.record_id===only):rows.slice())
    .sort((a,b)=>(scheduleMs(a.fields[F.schedule])??Infinity)-(scheduleMs(b.fields[F.schedule])??Infinity));
  if(only) log(`Chỉ xử lý RECORD_ID=${only} (${scan.length} dòng khớp) — bỏ qua mọi chốt giữ nhịp.`);
  else log(`Giữ nhịp: quá hạn ${CFG.GRACE_MIN}' thì thôi · ngưng sau ${CFG.MAX_FAIL} lần hỏng · video ≤ ${CFG.MAX_VIDEO_MB}MB · ${CFG.MOT_BAI_MOI_PAGE?'1 bài/page mỗi lượt':'không giới hạn bài/lượt'}.`);
  const nowMs=Date.now();
  const daDangLuotNay=new Set();   // fbId đã chạm tới ở lượt chạy này → nhường lượt sau
  const pageKhoaVideo=new Set();   // fbId Facebook đang khoá đăng video (code 368)
  let ok=0,err=0,wait=0,skip=0,quaHan=0,ngung=0,gian=0,khoa=0;
  for(const row of scan){
    const recId=row.record_id;
    if(plain(row.fields[F.status])===DONE) { skip++; continue; }              // đã đăng
    // Một dòng có thể chọn NHIỀU Page (link field cho phép multi) — đăng lên TẤT CẢ, không chỉ cái đầu tiên.
    const pageRecIds=linkRecIds(row.fields[F.link]);
    const atts=Array.isArray(row.fields[F.media])?row.fields[F.media]:[];
    if(!pageRecIds.length || atts.length===0) { skip++; continue; }           // dòng chưa sẵn sàng → bỏ qua im lặng
    const pages=[], missing=[];
    for(const prId of pageRecIds){ const pg=pageMap.get(prId); if(pg&&pg.fbId&&pg.token) pages.push(pg); else missing.push(prId); }
    if(!pages.length){ log(`  [LỖI] ${recId}: không Page nào có ID/token trong bảng Pages`); if(!DRY)await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - Page thiếu ID/token`}); err++; continue; }

    const logCu = plain(row.fields[F.log]);

    // ② NGƯNG — dòng đã hỏng đủ MAX_FAIL lần thì thôi, đừng nã Facebook nữa.
    if(!only && logCu.includes(NGUNG)){ ngung++; continue; }

    if(CFG.RESPECT_SCHEDULE){
      const s=scheduleMs(row.fields[F.schedule]);
      if(s&&s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}`); wait++; continue; }
      // ① QUÁ HẠN — trễ quá lâu thì đăng ra cũng lệch khung giờ, thà không đăng.
      // Sửa lại "Lịch đăng bài" sang giờ mới (hoặc bấm nút Đăng) là dòng sống lại.
      if(s && !only && CFG.GRACE_MIN>0 && (nowMs-s) > CFG.GRACE_MIN*60000){
        const tre=Math.round((nowMs-s)/60000);
        log(`  [QUÁ HẠN] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}, trễ ${tre} phút (trần ${CFG.GRACE_MIN}) — không đăng lệch giờ`);
        if(!DRY && !logCu.includes(QUA_HAN)){
          try{ await updateRow(tk,recId,{[F.log]:`${now()} - ${QUA_HAN} trễ ${tre} phút so với lịch, không đăng tự động nữa. Muốn đăng: sửa "Lịch đăng bài" sang giờ mới, hoặc bấm nút Đăng.`}); }catch{}
        }
        quaHan++; continue;
      }
    }

    // Biết sớm là ảnh hay video để chặn video quá nặng TRƯỚC khi tốn công tải file.
    const loai=plain(row.fields[F.type]);
    let kind = /video/i.test(loai) ? 'video' : /ảnh|hình|image|photo/i.test(loai) ? 'image' : (atts.some(isVid)?'video':'image');
    const files = kind==='video' ? [ atts.find(isVid)||atts[0] ] : atts.filter(a=>isImg(a)||!isVid(a));

    // ③ CHẶN NẶNG — Facebook trả 413 với video vượt cỡ. Thử là chắc chắn hỏng,
    // mà mỗi lần hỏng vẫn bị tính vào hạn mức tần suất của Page ⇒ chặn từ đây.
    if(kind==='video' && CFG.MAX_VIDEO_MB>0){
      const mb=(files[0]&&files[0].size||0)/1048576;
      if(mb > CFG.MAX_VIDEO_MB){
        const msg=`video ${mb.toFixed(1)}MB vượt trần ${CFG.MAX_VIDEO_MB}MB — Facebook sẽ từ chối (413). Nén nhẹ lại rồi thay file, xong bấm nút Đăng.`;
        log(`  [BỎ] ${recId}: ${msg}`);
        if(!DRY){ try{ await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - LỖI - ${msg} ${NGUNG}`}); }catch{} }
        err++; continue;
      }
    }

    // Page đang bị Facebook khoá video ở lượt này → đừng gõ cửa nữa.
    if(kind==='video' && pages.length && pages.every(p=>pageKhoaVideo.has(p.fbId))){
      log(`  [FB KHOÁ] ${recId}: ${pages.map(p=>p.name).join(', ')} đang bị khoá đăng video — bỏ qua, không thử thêm`);
      khoa++; continue;
    }

    // ④ GIÃN NHỊP — mỗi lượt chạy, mỗi page chỉ một bài. Cron 15 phút ⇒ hai bài
    // cùng page cách nhau ít nhất 15 phút, không bao giờ ra thành chùm.
    if(!only && CFG.MOT_BAI_MOI_PAGE && pages.some(p=>daDangLuotNay.has(p.fbId))){
      log(`  [GIÃN NHỊP] ${recId}: ${pages.map(p=>p.name).join(', ')} đã có bài ở lượt này — để lượt sau`);
      gian++; continue;
    }

    // ── GIÀNH CHỖ (xem ghi chú CHỐNG ĐĂNG TRÙNG ở đầu file) ──
    // Làm SAU mọi phép kiểm rẻ tiền ở trên, ngay TRƯỚC khi đụng vào Facebook.
    if(!DRY){
      const logHienTai = logCu;
      if(claimConHan(logHienTai)){
        log(`  [NHƯỜNG] ${recId}: lượt chạy khác đang đăng dòng này (${(logHienTai.match(CLAIM_RE)||[])[1]||'?'})`);
        skip++; continue;
      }
      if(CLAIM_RE.test(logHienTai)){
        // Dấu quá hạn = lượt chạy trước chết giữa chừng. Nhận lại để dòng không
        // kẹt mãi, NHƯNG báo to: nếu nó chết SAU khi đã đẩy lên Facebook thì đăng
        // lại sẽ ra bài trùng. Gặp dòng này nên mở page kiểm bằng mắt.
        log(`  [⚠ NHẬN LẠI] ${recId}: kẹt dấu ĐANG ĐĂNG quá ${CLAIM_TTL_MS/60000} phút — kiểm page xem đã có bài chưa!`);
      }
      try{ await updateRow(tk,recId,{[F.log]:claimLine(logHienTai)}); }
      catch(e){ log(`  [LỖI] ${recId}: không giành chỗ được - ${String(e.message||e).slice(0,120)}`); err++; continue; }

      // Đọc lại để chắc dấu còn là của mình. Hai lượt cùng ghi trong tích tắc
      // thì lượt ghi sau thắng — lượt thua phải nhường, không thì lại đăng đôi.
      try{
        const lai = await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
          {headers:{Authorization:'Bearer '+tk}}, 'recheck');
        const chu = (plain(lai?.data?.record?.fields?.[F.log]).match(CLAIM_RE)||[])[1];
        if(chu && chu!==RUN_TAG){ log(`  [NHƯỜNG] ${recId}: lượt ${chu} giành trước`); skip++; continue; }
      }catch(e){ log(`  [!] ${recId}: không đọc lại được để xác nhận (${String(e.message||e).slice(0,80)}) — vẫn đăng tiếp`); }
    }

    const caption=plain(row.fields[F.caption]);
    log(`  >> ${recId} | ${pages.map(p=>p.name).join(', ')} | ${kind} | ${files.length} file | "${caption.slice(0,40).replace(/\n/g,' ')}"`);
    // Ghi sổ NGAY, trước cả khi biết kết quả: đã chạm tới page này ở lượt chạy
    // hiện tại thì thôi, không nã tiếp — kể cả khi bài này hỏng. Đang bị Facebook
    // chặn tần suất mà cứ thử bài kế tiếp thì chỉ chặn nặng thêm.
    // Đặt trước nhánh DRY để chạy thử khô cũng thấy đúng nhịp thật.
    pages.forEach(p=>daDangLuotNay.add(p.fbId));
    if(DRY){ const c=plain(row.fields[F.comment]).trim(); if(c)log(`     [DRY] comment: ${c.slice(0,60)}`); continue; }

    const tmp=[];
    try{
      for(let i=0;i<files.length;i++){ const f=files[i]; const p=path.join(os.tmpdir(),`feed_${recId}_${i}_${(f.name||'m').replace(/[^\w.]/g,'')}`);
        await downloadMedia(tk,f.file_token,p); f.path=p; tmp.push(p); }
      const commentText=plain(row.fields[F.comment]).trim();
      const results=[];
      for(const pg of pages){
        try{
          // Dàn trang RIÊNG cho từng page: chân trang mang tên page đó.
          const anh = kind==='video' ? files
                    : await photobook.build(files,{ footer:pg.name, tag:`${recId}_${pg.fbId}`, tmp, log });
          const res = kind==='video' ? await postVideo(pg.fbId,pg.token,files[0],caption)
                                      : await postPhotos(pg.fbId,pg.token,anh,caption);
          let cmtNote=''; if(commentText){ try{ await postComment(pg.fbId,pg.token,res.objectId,commentText); cmtNote=' +cmt'; }
            catch(e){ cmtNote=' (cmt lỗi)'; log(`     ! comment lỗi (${pg.name}): ${String(e.message||e).slice(0,120)}`); } }
          results.push({ name:pg.name, ok:true, permalink:res.permalink, objectId:res.objectId, cmtNote });
          log(`     ✔ ĐĂNG ${pg.name}: ${res.permalink}`);
        }catch(e){ const msg=String(e.message||e).slice(0,200);
          const khoaVideo = laKhoaChinhSach(e) && kind==='video';
          if(khoaVideo){ pageKhoaVideo.add(pg.fbId);
            log(`     ⛔ ${pg.name}: FACEBOOK ĐANG KHOÁ ĐĂNG VIDEO (code 368) — không thử lại, chờ Facebook mở`); }
          else log(`     ✖ LỖI ${pg.name}: ${msg}`);
          results.push({ name:pg.name, ok:false, error:msg, khoaVideo }); }
      }
      if(missing.length) results.push(...missing.map(id=>({ name:id, ok:false, error:'Page thiếu ID/token trong bảng Pages' })));
      const anyOk=results.some(r=>r.ok), allOk=results.every(r=>r.ok);
      const firstOk=results.find(r=>r.ok);
      const logLine=results.map(r=>r.ok?`${r.name}: OK ${r.objectId}${r.cmtNote||''}`:`${r.name}: LỖI ${r.error}`).join(' | ');
      // Bị Facebook khoá thì KHÔNG đếm vào NGƯNG: lỗi nằm ở phía Facebook, không
      // ở dòng bài. Đếm vào đây thì tới ngày mở khoá dòng đã bị ngưng vĩnh viễn,
      // phải bấm tay từng dòng mới đăng lại được.
      const biKhoa = results.some(r=>r.khoaVideo);
      const duoi = anyOk ? '' : biKhoa
        ? ` ${NHAN_KHOA} Facebook đang tạm khoá đăng video trên page này (không phải lỗi bài). Kiểm tra: Meta Business Suite → Chất lượng tài khoản. Engine sẽ tự đăng lại khi Facebook mở khoá.`
        : dauLanThu(logCu);
      await updateRow(tk,recId,{ [F.status]: anyOk?DONE:FAIL, ...(firstOk?{[F.linkPost]:{link:firstOk.permalink,text:'Xem bài'}}:{}),
        [F.log]:`${now()} - ${allOk?'OK':'MỘT PHẦN'} - ${logLine}` + duoi });
      if(anyOk) ok++; else err++;
    }catch(e){ const msg=String(e.message||e).slice(0,300); log(`     ✖ LỖI: ${msg}`);
      try{await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - LỖI - ${msg}`+dauLanThu(logCu)});}catch{} err++;
    }finally{ tmp.forEach(p=>{try{fs.unlinkSync(p)}catch{}}); }
  }
  log(`Xong. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}, Giãn nhịp: ${gian}, Quá hạn: ${quaHan}, Đã ngưng: ${ngung}, FB khoá video: ${khoa}, Bỏ qua: ${skip}.`);
})().catch(e=>{console.error('FATAL',e.message||e);process.exit(1);});
