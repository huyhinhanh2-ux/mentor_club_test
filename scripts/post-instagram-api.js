#!/usr/bin/env node
/*
 * post-instagram-api.js — Đăng bài từ bảng "22.2 Đăng bài Instagram tự động" (Lark Base) lên INSTAGRAM.
 * Khuôn lấy từ post-feed-api.js (Facebook), nhưng dùng BẢNG RIÊNG 22.1 / 22.2.
 *
 * Chạy:  node scripts/post-instagram-api.js            (đăng các dòng đủ điều kiện)
 *        node scripts/post-instagram-api.js --dry-run  (chỉ liệt kê, không đăng, không ghi Base)
 *
 * Điều kiện đăng 1 dòng: Trạng thái ≠ "Thành công" + có link Tài khoản IG + có file Ảnh/video
 *   + (Lịch đăng bài trống hoặc đã tới giờ).
 *
 * ====================== KHÁC BIỆT CỐT LÕI SO VỚI FACEBOOK ======================
 * 1. IG KHÔNG nhận upload file ảnh — nó đòi **URL CÔNG KHAI** (image_url) để tự tải về.
 *    File trong Lark thì cần đăng nhập ⇒ không dùng trực tiếp được.
 *    → Cách gỡ KHÔNG cần hạ tầng riêng: đẩy ảnh lên chính **FB Page liên kết** dạng
 *      `published=false&temporary=true` (KHÔNG hiện trên feed, không ai thấy), rồi đọc
 *      `images[0].source` = link CDN công khai của Facebook → đưa cho IG → xoá ảnh tạm.
 *    → BONUS: Facebook tự chuyển PNG/WebP → JPEG, mà **IG TỪ CHỐI PNG** ⇒ vá luôn lỗi định dạng.
 *    → Vì vậy bảng 22.1 BẮT BUỘC có cột "Fanpage ID" (Page dùng để mượn CDN).
 * 2. VIDEO thì khác: upload thẳng lên rupload.facebook.com (resumable), KHÔNG cần URL công khai.
 * 3. IG đăng theo **container 2 nhịp**: tạo container → chờ xử lý xong → media_publish.
 * 4. IG **KHÔNG đăng được bài chỉ có chữ**. Không có ảnh/video → bỏ qua dòng.
 * 5. Hạn mức **100 bài / 24 giờ**. Caption tối đa 2.200 ký tự. Carousel 2–10 ảnh.
 * 6. 🛡️ CHỐNG SPAM: mỗi lần chạy chỉ đăng tối đa MAX_POSTS bài (mặc định 10).
 *    Đăng ồ ạt hàng chục bài liên tiếp = Meta đánh dấu SPAM. Đặt MAX_POSTS để nới.
 * ==============================================================================
 *
 * BIẾN MÔI TRƯỜNG:
 *   LARK_APP_ID        (bắt buộc)
 *   LARK_APP_SECRET    (bắt buộc)
 *   LARK_APP_TOKEN     (bắt buộc)  = GitHub Variable LARK_BASE_ID
 *   IG_POSTS_TABLE     (bắt buộc)  = bảng 22.2 (Đăng bài Instagram)
 *   IG_ACCOUNTS_TABLE  (bắt buộc)  = bảng 22.1 (Danh sách tài khoản IG)
 * Tùy chọn: LARK_DOMAIN, GRAPH_VERSION, RESPECT_SCHEDULE, RECORD_ID, MAX_POSTS.
 * Token IG = token Page (cột access_token bảng 22.1) — KHÔNG cần secret riêng.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:      process.env.LARK_APP_ID       || '',
  APP_SECRET:  process.env.LARK_APP_SECRET   || '',
  APP_TOKEN:   process.env.LARK_APP_TOKEN    || '',
  TABLE_ID:    process.env.IG_POSTS_TABLE    || '',
  ACC_TABLE:   process.env.IG_ACCOUNTS_TABLE || '',
  LARK_DOMAIN: process.env.LARK_DOMAIN       || 'https://open.larksuite.com',
  GRAPH_VERSION: process.env.GRAPH_VERSION   || 'v21.0',
  RESPECT_SCHEDULE: process.env.RESPECT_SCHEDULE !== 'false',
  MAX_POSTS:   parseInt(process.env.MAX_POSTS || '10', 10),
};
const GRAPH   = `https://graph.facebook.com/${CFG.GRAPH_VERSION}`;
const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${CFG.GRAPH_VERSION}`;
const DRY = process.argv.includes('--dry-run');
const _miss = [];
if(!CFG.APP_ID)     _miss.push('LARK_APP_ID');
if(!CFG.APP_SECRET) _miss.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)  _miss.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.TABLE_ID)   _miss.push('IG_POSTS_TABLE (bảng 22.2)');
if(!CFG.ACC_TABLE)  _miss.push('IG_ACCOUNTS_TABLE (bảng 22.1)');
if(_miss.length){ console.error('!! Thiếu biến môi trường: '+_miss.join(', ')); process.exit(1); }

// Cột bảng 22.2
const F = { link:'Tài khoản IG', type:'Loại', caption:'Nội dung', hashtag:'Hastag', media:'Ảnh/video',
            schedule:'Lịch đăng bài', status:'Trạng thái', log:'Log', linkPost:'Link bài đăng' };
const DONE='Thành công', FAIL='Thất bại';
const IG_CAPTION_MAX = 2200;

const now   = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log   = (...a) => console.log(now(), ...a);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name||'') || /^video/i.test(a.type||'');
const isImg = a => /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name||'') || /^image/i.test(a.type||'');
const linkRecIds = cell => { if(!cell) return [];
  const arr=Array.isArray(cell)?cell:[cell]; let ids=[];
  for(const el of arr){ if(!el) continue;
    if(Array.isArray(el.record_ids)) ids=ids.concat(el.record_ids);
    else if(el.record_id) ids.push(el.record_id);
    else if(typeof el==='string') ids.push(el); }
  return ids.filter(Boolean); };

/* ---------- Lark (có retry: Lark rất hay trả TooManyRequest 1254290) ---------- */
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
    if(j.code===1254290){ await sleep(1500*(i+1)); continue; }   // Lark bận → chờ rồi thử lại
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

/* ---------- Facebook / Instagram ---------- */
async function fbFetch(u,o){ const r=await fetch(u,o); const t=await r.text(); let j;
  try{ j=JSON.parse(t); }catch{ j={_raw:t}; }
  if(!r.ok||j.error) throw new Error('FB '+r.status+': '+JSON.stringify(j.error||j._raw||j)); return j; }

// Biến file ẢNH thành URL CÔNG KHAI qua CDN Facebook (xem giải thích ở đầu file).
async function imageToPublicUrl(pageId, token, file){
  const fd=new FormData();
  fd.set('access_token', token);
  fd.set('published','false');    // không hiện trên feed
  fd.set('temporary','true');     // không vào album Photos của Page
  fd.set('source', new Blob([fs.readFileSync(file.path)]), file.name||'photo.jpg');
  const up=await fbFetch(`${GRAPH}/${pageId}/photos`,{method:'POST',body:fd});
  if(!up.id) throw new Error('không upload được ảnh tạm lên FB Page');
  const info=await fbFetch(`${GRAPH}/${up.id}?fields=images&access_token=${encodeURIComponent(token)}`);
  const imgs=info.images||[];
  if(!imgs.length) throw new Error('FB không trả về link ảnh công khai');
  const best=imgs.reduce((a,b)=>(b.width||0)>(a.width||0)?b:a, imgs[0]);
  return { url:best.source, photoId:up.id };
}
async function cleanupTemp(token, ids){
  for(const id of ids){ try{ await fbFetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(token)}`,{method:'DELETE'}); }catch{} }
}
async function igContainer(igId, token, params){
  const j=await fbFetch(`${GRAPH}/${igId}/media`,{method:'POST',body:new URLSearchParams({...params, access_token:token})});
  if(!j.id) throw new Error('IG không trả về container id'); return j.id;
}
async function igUploadVideo(containerId, token, file){
  const buf=fs.readFileSync(file.path);
  const r=await fetch(`${RUPLOAD}/${containerId}`,{ method:'POST',
    headers:{ Authorization:`OAuth ${token}`, offset:'0', file_size:String(buf.length), 'Content-Type':'application/octet-stream' },
    body:buf });
  const t=await r.text(); let j; try{ j=JSON.parse(t); }catch{ j={_raw:t}; }
  if(!r.ok||j.error) throw new Error('rupload '+r.status+': '+JSON.stringify(j.error||j._raw));
  return j;
}
// Container xử lý BẤT ĐỒNG BỘ → phải chờ FINISHED mới publish được.
async function igWaitReady(cid, token, {tries=40, gapMs=5000}={}){
  for(let i=0;i<tries;i++){
    const s=await fbFetch(`${GRAPH}/${cid}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if(s.status_code==='FINISHED') return;
    if(s.status_code==='ERROR')    throw new Error('IG xử lý media lỗi: '+(s.status||'?'));
    if(s.status_code==='EXPIRED')  throw new Error('container hết hạn');
    await sleep(gapMs);
  }
  throw new Error(`IG xử lý media quá lâu (>${Math.round(tries*gapMs/1000)}s)`);
}
async function igPublish(igId, token, cid){
  const j=await fbFetch(`${GRAPH}/${igId}/media_publish`,{method:'POST',body:new URLSearchParams({creation_id:cid, access_token:token})});
  if(!j.id) throw new Error('media_publish không trả về id');
  let permalink='';
  try{ const p=await fbFetch(`${GRAPH}/${j.id}?fields=permalink&access_token=${encodeURIComponent(token)}`); permalink=p.permalink||''; }catch{}
  return { mediaId:j.id, permalink };
}

async function postToInstagram(acc, files, kind, caption){
  const { igId, token, pageId } = acc;
  const cap = caption.slice(0, IG_CAPTION_MAX);
  const temp = [];
  try{
    if(kind==='video'){
      const cid=await igContainer(igId, token, { media_type:'REELS', upload_type:'resumable', caption:cap, share_to_feed:'true' });
      await igUploadVideo(cid, token, files[0]);
      await igWaitReady(cid, token);
      return await igPublish(igId, token, cid);
    }
    if(!pageId) throw new Error('bảng 22.1 thiếu "Fanpage ID" — không mượn được CDN Facebook để tạo link ảnh công khai');

    if(files.length===1){
      const { url, photoId }=await imageToPublicUrl(pageId, token, files[0]); temp.push(photoId);
      const cid=await igContainer(igId, token, { image_url:url, caption:cap });
      await igWaitReady(cid, token, {tries:12, gapMs:2500});
      return await igPublish(igId, token, cid);
    }
    // Carousel: IG nhận 2–10 ảnh
    const pick=files.slice(0,10);
    if(files.length>10) log(`     ! IG chỉ nhận 10 ảnh/carousel — bỏ ${files.length-10} ảnh cuối.`);
    const children=[];
    for(const f of pick){
      const { url, photoId }=await imageToPublicUrl(pageId, token, f); temp.push(photoId);
      children.push(await igContainer(igId, token, { image_url:url, is_carousel_item:'true' }));
    }
    for(const c of children) await igWaitReady(c, token, {tries:12, gapMs:2500});
    const cid=await igContainer(igId, token, { media_type:'CAROUSEL', children:children.join(','), caption:cap });
    await igWaitReady(cid, token, {tries:12, gapMs:2500});
    return await igPublish(igId, token, cid);
  } finally {
    if(temp.length) await cleanupTemp(token, temp);
  }
}

/* ================================ MAIN ================================ */
(async()=>{
  const tk=await larkToken();

  // map record_id (22.1) → tài khoản IG
  const accRecs=await listAll(tk, CFG.ACC_TABLE);
  const accMap=new Map();
  for(const r of accRecs){
    const f=r.fields;
    const g=(re)=>{ const k=Object.keys(f).find(k=>re.test(k)); return k?plain(f[k]).trim():''; };
    accMap.set(r.record_id, {
      igId:  g(/ig.*user.*id/i),
      token: g(/token/i),
      pageId:g(/fanpage.*id/i),
      name:  g(/^t[àa]i kho[ản]n IG$|username/i) || '(IG)',
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
    // IG KHÔNG đăng được bài chỉ có chữ → thiếu media là bỏ qua (không tính lỗi).
    if(!accIds.length || atts.length===0){ skip++; continue; }

    const accs=[];
    for(const id of accIds){ const a=accMap.get(id); if(a && a.igId && a.token) accs.push(a); }
    if(!accs.length){
      log(`  [LỖI] ${recId}: tài khoản IG thiếu "IG User ID" hoặc "access_token" trong bảng 22.1`);
      if(!DRY) await updateRow(tk,recId,{[F.status]:FAIL,[F.log]:`${now()} - tài khoản IG thiếu ID/token`});
      err++; continue;
    }

    if(CFG.RESPECT_SCHEDULE){
      const s=scheduleMs(row.fields[F.schedule]);
      if(s && s>nowMs){ log(`  [CHỜ GIỜ] ${recId}: hẹn ${new Date(s).toISOString().slice(0,16)}`); wait++; continue; }
    }

    // 🛡️ Trần chống spam — đăng ồ ạt là bị Meta đánh dấu spam.
    if(!only && ok >= CFG.MAX_POSTS){ capped++; continue; }

    const body=plain(row.fields[F.caption]);
    const tags=plain(row.fields[F.hashtag]).trim();
    const caption=[body, tags].filter(Boolean).join('\n\n');
    const loai=plain(row.fields[F.type]);
    const kind = /video|reel/i.test(loai) ? 'video'
               : /ảnh|hình|image|photo|carousel/i.test(loai) ? 'image'
               : (atts.some(isVid)?'video':'image');
    const files = kind==='video' ? [ atts.find(isVid)||atts[0] ] : atts.filter(a=>isImg(a)||!isVid(a));
    if(!files.length){ skip++; continue; }

    log(`  >> ${recId} | ${accs.map(a=>a.name).join(', ')} | ${kind} | ${files.length} file | "${caption.slice(0,40).replace(/\n/g,' ')}"`);
    if(caption.length>IG_CAPTION_MAX) log(`     ! caption ${caption.length} ký tự > ${IG_CAPTION_MAX} → sẽ bị cắt.`);
    if(DRY) continue;

    const tmp=[];
    try{
      for(let i=0;i<files.length;i++){
        const f=files[i];
        const p=path.join(os.tmpdir(), `ig_${recId}_${i}_${(f.name||'m').replace(/[^\w.]/g,'')}`);
        await downloadMedia(tk, f.file_token, p); f.path=p; tmp.push(p);
      }
      const results=[];
      for(const a of accs){
        try{
          const res=await postToInstagram(a, files, kind, caption);
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
        ...(firstOk && firstOk.permalink ? {[F.linkPost]:{link:firstOk.permalink, text:'Xem IG'}} : {}),
        [F.log]: `${now()} - ${allOk?'OK':'MỘT PHẦN'} - ${line}`,
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
  log(`Xong IG. Đăng: ${ok}, Lỗi: ${err}, Chờ giờ: ${wait}, Bỏ qua: ${skip}${capped?`, HOÃN (quá trần ${CFG.MAX_POSTS}/lần): ${capped}`:''}.`);
  if(capped) log(`  → ${capped} bài chưa đăng để tránh bị Meta coi là spam. Chạy lại sau, hoặc đặt MAX_POSTS cao hơn.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
