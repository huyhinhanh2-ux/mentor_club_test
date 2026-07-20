#!/usr/bin/env node
/*
 * post-threads-api.js — Đăng bài từ bảng "23.3 Đăng bài Threads tự động" (Lark Base) lên THREADS.
 *
 * Chạy:  node scripts/post-threads-api.js            (đăng)
 *        node scripts/post-threads-api.js --dry-run  (chỉ liệt kê, không đăng, không ghi Base)
 *
 * ⚠️ CHƯA CHẠY THỬ (2026-07-13) — chờ token Threads. Sẽ có lỗi vặt khi chạy thật lần đầu.
 *
 * ============== THREADS KHÁC FACEBOOK & INSTAGRAM Ở ĐÂU ==============
 * 1. Host RIÊNG `graph.threads.net`. Token RIÊNG — token Facebook/Page đưa sang BỊ TỪ CHỐI.
 *    OAuth riêng qua threads.net (threads_basic + threads_content_publish). Token sống 60 NGÀY;
 *    phải gia hạn TRƯỚC HẠN bằng /refresh_access_token, để chết là làm lại từ đầu.
 * 2. Threads ĐĂNG ĐƯỢC BÀI TOÀN CHỮ (Instagram thì không). Nhưng chặn cứng 500 "ký tự" —
 *    và ⚠️ EMOJI ĐẾM THEO SỐ BYTE UTF-8, KHÔNG PHẢI 1. Đếm sai là bài bị từ chối (xem thLen()).
 *    Caption Facebook thường dài hơn ⇒ engine nhờ Claude VIẾT LẠI cho gọn mà GIỮ NGUYÊN Ý,
 *    rồi ghi bản rút gọn ngược vào cột "Nội dung rút gọn" để người dùng xem/sửa và lần sau
 *    KHÔNG phải gọi AI lại (tiết kiệm tiền + kết quả ổn định).
 * 3. Ảnh/video phải là **URL CÔNG KHAI** (không nhận upload file), giống Instagram.
 *    → Mượn CDN Facebook: đẩy media lên FB Page dạng published=false (không ai thấy trên feed),
 *      lấy link CDN công khai, đưa cho Threads, rồi xoá media tạm.
 *      Bonus: FB tự chuyển PNG/WebP → JPEG.
 *    → Vì vậy dòng CÓ MEDIA bắt buộc: tài khoản Threads (23.2) phải nối tới tài khoản IG (22.1),
 *      để mượn "Fanpage ID" + token Page. Bài CHỈ CÓ CHỮ thì không cần gì cả.
 * 4. Đăng theo container 2 nhịp: POST /{user-id}/threads → chờ FINISHED → /threads_publish.
 * 5. Giới hạn khác: 250 bài/24h · ảnh ≤8MB, rộng ≤1440px · video MP4/MOV ≤5 phút, ≤1GB.
 * =====================================================================
 *
 * BIẾN MÔI TRƯỜNG:
 *   LARK_APP_ID · LARK_APP_SECRET · LARK_APP_TOKEN (=LARK_BASE_ID)      (bắt buộc)
 *   TH_POSTS_TABLE     = bảng 23.3                                       (bắt buộc)
 *   TH_ACCOUNTS_TABLE  = bảng 23.2                                       (bắt buộc)
 *   IG_ACCOUNTS_TABLE  = bảng 22.1  (chỉ cần khi đăng ẢNH/VIDEO — mượn CDN Facebook)
 *   ANTHROPIC_API_KEY  (TÙY CHỌN)  — để AI cô đọng bài >500 ký tự.
 *                       Không có → engine tự cắt ở ranh giới câu (mất đuôi, có ghi cảnh báo vào Log).
 * Tùy chọn: LARK_DOMAIN, GRAPH_VERSION, RESPECT_SCHEDULE, RECORD_ID, MAX_POSTS (mặc định 10).
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:      process.env.LARK_APP_ID       || '',
  APP_SECRET:  process.env.LARK_APP_SECRET   || '',
  APP_TOKEN:   process.env.LARK_APP_TOKEN    || '',
  TABLE_ID:    process.env.TH_POSTS_TABLE    || '',
  ACC_TABLE:   process.env.TH_ACCOUNTS_TABLE || '',
  IG_TABLE:    process.env.IG_ACCOUNTS_TABLE || '',
  AI_KEY:      process.env.ANTHROPIC_API_KEY || '',
  LARK_DOMAIN: process.env.LARK_DOMAIN       || 'https://open.larksuite.com',
  GRAPH_VERSION: process.env.GRAPH_VERSION   || 'v21.0',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false',
  MAX_POSTS:   parseInt(process.env.MAX_POSTS || '10', 10),
};
const THREADS = 'https://graph.threads.net/v1.0';
const GRAPH   = `https://graph.facebook.com/${CFG.GRAPH_VERSION}`;
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)     _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET) _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)  _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.TABLE_ID)   _miss.push('TH_POSTS_TABLE (bảng 23.3)');
if(!CFG.ACC_TABLE)  _miss.push('TH_ACCOUNTS_TABLE (bảng 23.2)');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')); process.exit(1); }

// Cột bảng 23.3
const F = { link:'Tài khoản Threads', type:'Loại', caption:'Nội dung', short:'Nội dung rút gọn',
            media:'Ảnh/video', schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const DONE='Thành công', FAIL='Thất bại';

const THREADS_MAX    = 500;   // trần cứng của Threads
const THREADS_TARGET = 450;   // đích cho AI — chừa biên vì cách đếm emoji của Threads

const now   = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log   = (...a) => console.log(now(), ...a);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const linkRecIds = cell => { if(!cell) return [];
  const arr=Array.isArray(cell)?cell:[cell]; let ids=[];
  for(const el of arr){ if(!el) continue;
    if(Array.isArray(el.record_ids)) ids=ids.concat(el.record_ids);
    else if(el.record_id) ids.push(el.record_id);
    else if(typeof el==='string') ids.push(el); }
  return ids.filter(Boolean); };

/* ---------- Đếm & cắt THEO CÁCH THREADS ĐẾM ----------
 * Threads: 500 "ký tự", nhưng EMOJI đếm theo SỐ BYTE UTF-8 chứ không phải 1.
 * Chữ Việt có dấu nằm dưới U+2000 nên vẫn tính 1. Từ U+2000 trở lên (emoji, ký hiệu, dấu "…")
 * ta đếm theo byte — đếm dư một chút thì an toàn, đếm thiếu thì bài BỊ THREADS TỪ CHỐI.
 */
function thLen(s){
  let n=0;
  for(const ch of s){ n += ch.codePointAt(0) >= 0x2000 ? Buffer.byteLength(ch,'utf8') : 1; }
  return n;
}
function thCut(s, max){
  let n=0, out='';
  for(const ch of s){
    const c = ch.codePointAt(0) >= 0x2000 ? Buffer.byteLength(ch,'utf8') : 1;
    if(n+c > max) break;
    n+=c; out+=ch;
  }
  return out;
}
// Cắt "gọn": ưu tiên dừng ở cuối câu, rồi tới cuối từ; chỉ thêm "…" nếu thật sự bị cắt giữa chừng.
function smartTrim(s, max){
  if(thLen(s) <= max) return s;
  let body = thCut(s, max-3);   // chừa chỗ cho "…" — U+2026 ≥ 0x2000 nên tốn 3, không phải 1
  const stop = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '), body.lastIndexOf('\n'));
  if(stop > body.length*0.6) body = body.slice(0, stop+1);
  else { const sp = body.lastIndexOf(' '); if(sp > body.length*0.6) body = body.slice(0, sp); }
  body = body.trim();
  return /[.!?…]$/.test(body) ? body : body + '…';   // dừng đúng cuối câu thì thôi "…"
}

/* ---------- Lark (có retry — Lark rất hay trả TooManyRequest 1254290) ---------- */
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
async function updateRow(tk, recId, fields){
  await larkCall(tk, `${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${CFG.TABLE_ID}/records/${recId}`,
    {method:'PUT', body:JSON.stringify({fields})}, 'update');
}
async function downloadMedia(tk, fileToken, out){
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:CFG.TABLE_ID}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for(const u of tries){ const r=await fetch(u,{headers:{Authorization:'Bearer '+tk}});
    if(r.ok && (r.headers.get('content-type')||'').indexOf('json')<0){
      const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được media từ Lark');
}
function scheduleMs(cell){ if(cell==null)return null; if(typeof cell==='number')return cell;
  const t=plain(cell).trim(); if(!t)return null;
  const m=t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); if(m)return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]).getTime();
  const d=new Date(t); return isNaN(d)?null:d.getTime(); }

async function api(u,o,who){ const r=await fetch(u,o); const t=await r.text(); let j;
  try{ j=JSON.parse(t); }catch{ j={_raw:t}; }
  if(!r.ok||j.error) throw new Error(`${who} ${r.status}: `+JSON.stringify(j.error||j._raw||j)); return j; }

/* ---------- Mượn CDN Facebook để tạo URL công khai ---------- */
async function imageToPublicUrl(pageId, pageToken, file){
  const fd=new FormData();
  fd.set('access_token', pageToken);
  fd.set('published','false'); fd.set('temporary','true');
  fd.set('source', new Blob([fs.readFileSync(file.path)]), file.name||'photo.jpg');
  const up=await api(`${GRAPH}/${pageId}/photos`,{method:'POST',body:fd},'FB');
  if(!up.id) throw new Error('không upload được ảnh tạm lên FB Page');
  const info=await api(`${GRAPH}/${up.id}?fields=images&access_token=${encodeURIComponent(pageToken)}`,{},'FB');
  const imgs=info.images||[];
  if(!imgs.length) throw new Error('FB không trả về link ảnh công khai');
  // Threads TỪ CHỐI ảnh rộng > 1440px → ưu tiên bản lớn nhất mà vẫn ≤1440.
  const fit=imgs.filter(i=>(i.width||0)<=1440);
  const pool=fit.length?fit:imgs;
  const best=pool.reduce((a,b)=>(b.width||0)>(a.width||0)?b:a, pool[0]);
  return { url:best.source, photoId:up.id };
}
async function videoToPublicUrl(pageId, pageToken, file){
  const fd=new FormData();
  fd.set('access_token', pageToken);
  fd.set('published','false');
  fd.set('source', new Blob([fs.readFileSync(file.path)]), file.name||'video.mp4');
  const up=await api(`${GRAPH}/${pageId}/videos`,{method:'POST',body:fd},'FB');
  if(!up.id) throw new Error('không upload được video tạm lên FB Page');
  for(let i=0;i<60;i++){   // FB cần vài phút mới xử lý xong video
    const s=await api(`${GRAPH}/${up.id}?fields=source,status&access_token=${encodeURIComponent(pageToken)}`,{},'FB');
    const st=String((s.status && s.status.video_status)||'').toLowerCase();
    if(st==='ready' && s.source) return { url:s.source, videoId:up.id };
    if(st==='error') throw new Error('FB xử lý video tạm lỗi');
    await sleep(5000);
  }
  throw new Error('FB xử lý video tạm quá lâu (>5 phút)');
}
async function cleanupTemp(pageToken, ids){
  for(const id of ids){ try{ await api(`${GRAPH}/${id}?access_token=${encodeURIComponent(pageToken)}`,{method:'DELETE'},'FB'); }catch{} }
}

/* ---------- Threads ---------- */
async function thContainer(userId, token, params){
  const j=await api(`${THREADS}/${userId}/threads`,{method:'POST',body:new URLSearchParams({...params, access_token:token})},'Threads');
  if(!j.id) throw new Error('Threads không trả về container id'); return j.id;
}
async function thWaitReady(cid, token, {tries=40, gapMs=5000}={}){
  for(let i=0;i<tries;i++){
    const s=await api(`${THREADS}/${cid}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,{},'Threads');
    if(s.status==='FINISHED' || s.status==='PUBLISHED') return;
    if(s.status==='ERROR')   throw new Error('Threads xử lý media lỗi: '+(s.error_message||'?'));
    if(s.status==='EXPIRED') throw new Error('container Threads hết hạn');
    await sleep(gapMs);
  }
  throw new Error('Threads xử lý media quá lâu');
}
async function thPublish(userId, token, cid){
  const j=await api(`${THREADS}/${userId}/threads_publish`,{method:'POST',body:new URLSearchParams({creation_id:cid, access_token:token})},'Threads');
  if(!j.id) throw new Error('threads_publish không trả về id');
  let permalink='';
  try{ const p=await api(`${THREADS}/${j.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,{},'Threads'); permalink=p.permalink||''; }catch{}
  return { mediaId:j.id, permalink };
}

/* ---------- AI cô đọng bài cho vừa 500 ký tự ----------
 * Gọi thẳng Messages API bằng fetch (Node 18+ có sẵn) — KHÔNG dùng SDK, để giữ bất biến
 * "fork repo về là chạy, không phải cài npm package nào".
 */
async function condense(text, apiKey){
  const system =
    'Bạn là biên tập viên mạng xã hội tiếng Việt. Nhiệm vụ: VIẾT LẠI bài đăng cho NGẮN HƠN, CÔ ĐỌNG HƠN '
  + 'mà KHÔNG ĐỔI Ý NGHĨA.\n'
  + 'Quy tắc bắt buộc:\n'
  + `- Tối đa ${THREADS_TARGET} ký tự. Đây là trần cứng.\n`
  + '- Giữ nguyên: thông điệp chính, lời kêu gọi hành động, số liệu, giá, tên riêng, link.\n'
  + '- Giữ tiếng Việt có dấu và giọng văn gốc. Giữ xuống dòng cho dễ đọc.\n'
  + '- Giữ tối đa 3 hashtag quan trọng nhất, bỏ phần còn lại. Giữ emoji nếu nó mang nghĩa.\n'
  + '- TUYỆT ĐỐI KHÔNG bịa thêm thông tin, không đổi số liệu.\n'
  + 'CHỈ trả về nội dung bài đăng đã rút gọn. Không mở đầu, không giải thích, không đặt trong ngoặc kép.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'x-api-key':apiKey, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 2000,                  // bài ra chỉ ~500 ký tự — đây là trần an toàn
      output_config: { effort: 'low' },  // viết lại ngắn: không cần suy nghĩ sâu
      system,
      messages: [{ role:'user', content: text }],
    }),
  });
  const t=await r.text(); let j; try{ j=JSON.parse(t); }catch{ j={_raw:t}; }
  if(!r.ok || j.error) throw new Error('Claude '+r.status+': '+JSON.stringify(j.error||j._raw||j));
  if(j.stop_reason === 'refusal') throw new Error('Claude từ chối viết lại nội dung này');
  const out=(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  if(!out) throw new Error('Claude trả về rỗng');
  return out.replace(/^["'“”]+|["'“”]+$/g,'').trim();
}

/* Quyết định nội dung sẽ đăng. Trả về { text, note, save }.
 * save = bản cần ghi ngược vào cột "Nội dung rút gọn" (để lần sau khỏi gọi AI lại).
 */
async function threadsTextFor(caption, manual){
  if(manual){   // người dùng đã tự soạn bản rút gọn → tôn trọng tuyệt đối, không gọi AI
    const t = thLen(manual) > THREADS_MAX ? smartTrim(manual, THREADS_MAX) : manual;
    return { text:t, note: t===manual ? 'dùng "Nội dung rút gọn"' : 'dùng "Nội dung rút gọn" (đã cắt cho vừa 500)', save:null };
  }
  if(thLen(caption) <= THREADS_MAX) return { text:caption, note:'dùng nguyên nội dung gốc', save:null };
  if(!CFG.AI_KEY){
    return { text: smartTrim(caption, THREADS_MAX),
             note: 'CẮT CỤT (thiếu ANTHROPIC_API_KEY nên không cô đọng được bằng AI)', save:null };
  }
  const ai = await condense(caption, CFG.AI_KEY);
  const t  = thLen(ai) > THREADS_MAX ? smartTrim(ai, THREADS_MAX) : ai;   // lưới an toàn
  return { text:t, note:`AI cô đọng ${thLen(caption)}→${thLen(t)} ký tự`, save:t };
}

/* ---------- Đăng 1 dòng ---------- */
async function postToThreads(acc, files, kind, text){
  const { thId, thToken, pageId, pageToken } = acc;
  const temp=[];
  try{
    if(kind==='text' || !files.length){   // Threads đăng được bài toàn chữ (Instagram thì không)
      const cid=await thContainer(thId, thToken, { media_type:'TEXT', text });
      return await thPublish(thId, thToken, cid);
    }
    if(!pageId || !pageToken)
      throw new Error('bài có ảnh/video nhưng tài khoản Threads (23.2) chưa nối tới tài khoản IG (22.1) — không mượn được CDN Facebook để tạo URL công khai');

    if(kind==='video'){
      const { url, videoId }=await videoToPublicUrl(pageId, pageToken, files[0]); temp.push(videoId);
      const cid=await thContainer(thId, thToken, { media_type:'VIDEO', video_url:url, text });
      await thWaitReady(cid, thToken, {tries:60, gapMs:5000});
      return await thPublish(thId, thToken, cid);
    }
    if(files.length===1){
      const { url, photoId }=await imageToPublicUrl(pageId, pageToken, files[0]); temp.push(photoId);
      const cid=await thContainer(thId, thToken, { media_type:'IMAGE', image_url:url, text });
      await thWaitReady(cid, thToken);
      return await thPublish(thId, thToken, cid);
    }
    // Nhiều ảnh → CAROUSEL (Threads nhận 2–20)
    const pick=files.slice(0,20);
    if(files.length>20) log(`     ! Threads chỉ nhận 20 ảnh — bỏ ${files.length-20} ảnh cuối.`);
    const children=[];
    for(const f of pick){
      const { url, photoId }=await imageToPublicUrl(pageId, pageToken, f); temp.push(photoId);
      children.push(await thContainer(thId, thToken, { media_type:'IMAGE', image_url:url, is_carousel_item:'true' }));
    }
    for(const c of children) await thWaitReady(c, thToken);
    const cid=await thContainer(thId, thToken, { media_type:'CAROUSEL', children:children.join(','), text });
    await thWaitReady(cid, thToken);
    return await thPublish(thId, thToken, cid);
  } finally {
    if(temp.length && pageToken) await cleanupTemp(pageToken, temp);
  }
}

/* ================================ MAIN ================================ */
(async()=>{
  const tk=await larkToken();

  // 22.1 — mượn Fanpage ID + token Page (chỉ cần khi bài có ảnh/video)
  const igMap=new Map();
  if(CFG.IG_TABLE){
    for(const r of await listAll(tk, CFG.IG_TABLE)){
      const f=r.fields;
      const g=(re)=>{ const k=Object.keys(f).find(k=>re.test(k)); return k?plain(f[k]).trim():''; };
      igMap.set(r.record_id, { pageId:g(/fanpage.*id/i), pageToken:g(/token/i) });
    }
  }
  // 23.2 — tài khoản Threads
  const accMap=new Map();
  for(const r of await listAll(tk, CFG.ACC_TABLE)){
    const f=r.fields;
    const g=(re)=>{ const k=Object.keys(f).find(k=>re.test(k)); return k?plain(f[k]).trim():''; };
    const ig=igMap.get(linkRecIds(f['Tài khoản IG'])[0]);
    accMap.set(r.record_id, {
      thId:    g(/threads.*user.*id/i),
      thToken: g(/token/i),
      name:    g(/^t[àa]i kho[ản]n Threads$|username/i) || '(Threads)',
      pageId:    ig?.pageId    || '',
      pageToken: ig?.pageToken || '',
    });
  }

  const rows=await listAll(tk, CFG.TABLE_ID);
  const only=(process.env.RECORD_ID||'').trim();
  const scan=only?rows.filter(r=>r.record_id===only):rows;
  if(only) log(`Chỉ xử lý RECORD_ID=${only} (${scan.length} dòng khớp).`);

  const nowMs=Date.now();
  let ok=0, err=0, wait=0, skip=0, capped=0;

  for(const row of scan){
    const recId=row.record_id;
    if(plain(row.fields[F.status])===DONE){ skip++; continue; }

    const accIds=linkRecIds(row.fields[F.link]);
    const atts=Array.isArray(row.fields[F.media])?row.fields[F.media]:[];
    const caption=plain(row.fields[F.caption]).trim();
    const manual =plain(row.fields[F.short]).trim();
    if(!accIds.length || (!caption && !manual && atts.length===0)){ skip++; continue; }

    const accs=[];
    for(const id of accIds){ const a=accMap.get(id); if(a && a.thId && a.thToken) accs.push(a); }
    if(!accs.length){
      log(`  [LỖI] ${recId}: tài khoản Threads thiếu "Threads User ID" hoặc "access_token" ở bảng 23.2`);
      if(!DRY) await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - tài khoản Threads thiếu ID/token`});
      err++; continue;
    }

    if(CFG.RESPECT_SCHEDULE){
      const s=scheduleMs(row.fields[F.schedule]);
      if(s && s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}`); wait++; continue; }
    }
    if(!only && ok >= CFG.MAX_POSTS){ capped++; continue; }

    const loai=plain(row.fields[F.type]);
    const kind = atts.length===0 ? 'text'
               : /video/i.test(loai) ? 'video'
               : /chữ|text/i.test(loai) ? 'text'
               : (atts.some(isVid)?'video':'image');
    const files = kind==='text' ? []
                : kind==='video' ? [ atts.find(isVid)||atts[0] ]
                : atts.filter(a=>!isVid(a));

    let text, note, save;
    try{ ({text, note, save} = await threadsTextFor(caption, manual)); }
    catch(e){
      const msg='cô đọng nội dung lỗi: '+String(e.message||e).slice(0,150);
      log(`  ✖ ${recId}: ${msg}`);
      if(!DRY) await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - ${msg}`});
      err++; continue;
    }

    log(`  >> ${recId} | ${accs.map(a=>a.name).join(', ')} | ${kind} | ${files.length} file | ${thLen(text)}/500 | ${note}`);
    log(`     "${text.slice(0,60).replace(/\n/g,' ')}"`);
    if(DRY) continue;

    const tmp=[];
    try{
      for(let i=0;i<files.length;i++){
        const f=files[i];
        const p=path.join(os.tmpdir(), `th_${recId}_${i}_${(f.name||'m').replace(/[^\w.]/g,'')}`);
        await downloadMedia(tk, f.file_token, p); f.path=p; tmp.push(p);
      }
      const results=[];
      for(const a of accs){
        try{
          const res=await postToThreads(a, files, kind, text);
          results.push({ name:a.name, ok:true, ...res });
          log(`     ✔ ĐĂNG ${a.name}: ${res.permalink||res.mediaId}`);
        }catch(e){
          const msg=String(e.message||e).slice(0,200);
          results.push({ name:a.name, ok:false, error:msg });
          log(`     ✖ LỖI ${a.name}: ${msg}`);
        }
      }
      const anyOk=results.some(r=>r.ok), allOk=results.every(r=>r.ok);
      const firstOk=results.find(r=>r.ok);
      const line=results.map(r=>r.ok?`${r.name}: OK ${r.mediaId}`:`${r.name}: LỖI ${r.error}`).join(' | ');
      await updateRow(tk, recId, {
        [F.status]: anyOk?DONE:FAIL,
        ...(save ? {[F.short]: save} : {}),   // lưu bản AI rút gọn → lần sau khỏi gọi AI lại
        ...(firstOk && firstOk.permalink ? {[F.linkPost]:{link:firstOk.permalink, text:'Xem Threads'}} : {}),
        [F.log]: `${now()} - ${allOk?'OK':'MỘT PHẦN'} - ${note} - ${line}`,
      });
      if(anyOk) ok++; else err++;
    }catch(e){
      const msg=String(e.message||e).slice(0,300);
      log(`     ✖ LỖI: ${msg}`);
      try{ await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - LỖI - ${msg}`}); }catch{}
      err++;
    }finally{
      tmp.forEach(p=>{ try{ fs.unlinkSync(p); }catch{} });
    }
  }
  log(`Xong Threads. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}, Bỏ qua: ${skip}${capped?`, HOÃN (trần ${CFG.MAX_POSTS}/lần): ${capped}`:''}.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
