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
 * Token Facebook lấy TỪ bảng Pages (cột access_token) — không cần env FB.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:       process.env.LARK_APP_ID    || '',
  APP_SECRET:   process.env.LARK_APP_SECRET|| '',
  APP_TOKEN:    process.env.LARK_APP_TOKEN || '',   // = GitHub Variable LARK_BASE_ID (base token)
  TABLE_ID:     process.env.LARK_TABLE_ID  || '',   // = GitHub Variable TABLE_DANGBAI
  PAGES_TABLE:  process.env.PAGES_TABLE_ID || '',   // = GitHub Variable TABLE_PAGES
  LARK_DOMAIN:  process.env.LARK_DOMAIN    || 'https://open.larksuite.com',
  GRAPH_VERSION:process.env.GRAPH_VERSION  || 'v21.0',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false',
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
const CLAIM_TTL_MS = 20 * 60 * 1000;
const RUN_TAG = process.env.GITHUB_RUN_ID
  ? `run${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT || 1}`
  : `local${process.pid}.${Date.now().toString(36)}`;
const CLAIM_RE = /ĐANG ĐĂNG \(([^)]+)\)/;

// Dòng Log lúc giành chỗ — có cả giờ để biết claim cũ đã thiu chưa.
const claimLine = () => `${now()} - ĐANG ĐĂNG (${RUN_TAG})`;

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
async function fbFetch(u,o){ const r=await fetch(u,o); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
  if(!r.ok||j.error)throw new Error('FB '+r.status+': '+JSON.stringify(j.error||j._raw||j)); return j; }

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
async function postVideo(pageId, token, file, caption) {
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
  const scan=only?rows.filter(r=>r.record_id===only):rows;
  if(only) log(`Chỉ xử lý RECORD_ID=${only} (${scan.length} dòng khớp).`);
  const nowMs=Date.now();
  let ok=0,err=0,wait=0,skip=0;
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

    if(CFG.RESPECT_SCHEDULE){ const s=scheduleMs(row.fields[F.schedule]); if(s&&s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}`); wait++; continue; } }

    // ── GIÀNH CHỖ (xem ghi chú CHỐNG ĐĂNG TRÙNG ở đầu file) ──
    // Làm SAU mọi phép kiểm rẻ tiền ở trên, ngay TRƯỚC khi đụng vào Facebook.
    if(!DRY){
      const logHienTai = plain(row.fields[F.log]);
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
      try{ await updateRow(tk,recId,{[F.log]:claimLine()}); }
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
    const loai=plain(row.fields[F.type]);
    let kind = /video/i.test(loai) ? 'video' : /ảnh|hình|image|photo/i.test(loai) ? 'image' : (atts.some(isVid)?'video':'image');
    const files = kind==='video' ? [ atts.find(isVid)||atts[0] ] : atts.filter(a=>isImg(a)||!isVid(a));
    log(`  >> ${recId} | ${pages.map(p=>p.name).join(', ')} | ${kind} | ${files.length} file | "${caption.slice(0,40).replace(/\n/g,' ')}"`);
    if(DRY){ const c=plain(row.fields[F.comment]).trim(); if(c)log(`     [DRY] comment: ${c.slice(0,60)}`); continue; }

    const tmp=[];
    try{
      for(let i=0;i<files.length;i++){ const f=files[i]; const p=path.join(os.tmpdir(),`feed_${recId}_${i}_${(f.name||'m').replace(/[^\w.]/g,'')}`);
        await downloadMedia(tk,f.file_token,p); f.path=p; tmp.push(p); }
      const commentText=plain(row.fields[F.comment]).trim();
      const results=[];
      for(const pg of pages){
        try{
          const res = kind==='video' ? await postVideo(pg.fbId,pg.token,files[0],caption)
                                      : await postPhotos(pg.fbId,pg.token,files,caption);
          let cmtNote=''; if(commentText){ try{ await postComment(pg.fbId,pg.token,res.objectId,commentText); cmtNote=' +cmt'; }
            catch(e){ cmtNote=' (cmt lỗi)'; log(`     ! comment lỗi (${pg.name}): ${String(e.message||e).slice(0,120)}`); } }
          results.push({ name:pg.name, ok:true, permalink:res.permalink, objectId:res.objectId, cmtNote });
          log(`     ✔ ĐĂNG ${pg.name}: ${res.permalink}`);
        }catch(e){ const msg=String(e.message||e).slice(0,200); results.push({ name:pg.name, ok:false, error:msg }); log(`     ✖ LỖI ${pg.name}: ${msg}`); }
      }
      if(missing.length) results.push(...missing.map(id=>({ name:id, ok:false, error:'Page thiếu ID/token trong bảng Pages' })));
      const anyOk=results.some(r=>r.ok), allOk=results.every(r=>r.ok);
      const firstOk=results.find(r=>r.ok);
      const logLine=results.map(r=>r.ok?`${r.name}: OK ${r.objectId}${r.cmtNote||''}`:`${r.name}: LỖI ${r.error}`).join(' | ');
      await updateRow(tk,recId,{ [F.status]: anyOk?DONE:FAIL, ...(firstOk?{[F.linkPost]:{link:firstOk.permalink,text:'Xem bài'}}:{}),
        [F.log]:`${now()} - ${allOk?'OK':'MỘT PHẦN'} - ${logLine}` });
      if(anyOk) ok++; else err++;
    }catch(e){ const msg=String(e.message||e).slice(0,300); log(`     ✖ LỖI: ${msg}`);
      try{await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - LỖI - ${msg}`});}catch{} err++;
    }finally{ tmp.forEach(p=>{try{fs.unlinkSync(p)}catch{}}); }
  }
  log(`Xong. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}, Bỏ qua: ${skip}.`);
})().catch(e=>{console.error('FATAL',e.message||e);process.exit(1);});
