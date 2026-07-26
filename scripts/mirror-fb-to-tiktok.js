#!/usr/bin/env node
/*
 * mirror-fb-to-tiktok.js — TỰ ĐỘNG NẠP VIDEO Facebook → NHÁP TikTok (Creator Inbox) qua Zernio.
 *
 * Ý tưởng (chốt với CEO 2026-07-27): mỗi VIDEO của Page Bầu/Newborn đã ĐĂNG FACEBOOK THÀNH CÔNG thì
 * lấy chính video đó NẠP VÀO HỘP THƯ NHÁP của tài khoản TikTok TƯƠNG ỨNG. CEO chủ động mở app TikTok,
 * thêm nhạc trend + sửa caption + bấm đăng. Máy chỉ lo phần nặng: bê video lên nằm sẵn trong nháp.
 *
 * PHÂN LUỒNG THEO PAGE (mỗi page đổ đúng tài khoản TikTok của nó):
 *   Page Bầu (BAU_PAGE_ID)         → TikTok @thoministudio_chupanhbau  (profile "Default")
 *   Page Newborn (NEWBORN_PAGE_ID) → TikTok @th.mini.newborn          (profile "tiktok newborn")
 *   ⚠️ Zernio: mỗi PROFILE chỉ chứa 1 tài khoản TikTok ⇒ mỗi tài khoản có accountId + profileId RIÊNG.
 *      Gửi post PHẢI kèm ĐÚNG cặp {accountId, profileId} của tài khoản đó.
 *
 * VÌ SAO ĐÂY LÀ "NHÁP TRONG APP" CHỨ KHÔNG PHẢI ĐĂNG THẲNG:
 *   Gọi Zernio với publishNow:true + tiktokSettings.draft:true ⇒ Zernio dùng cửa "inbox upload"
 *   của TikTok (publish_id trả về có tiền tố `v_inbox_url~`) ⇒ video vào Creator Inbox, KHÔNG lên
 *   sóng công khai (không có publishedUrl). Né hoàn toàn "bẫy SELF_ONLY" của app chưa audit, vì
 *   CEO mới là người bấm đăng và tự chọn công khai. (Đã test thật 2026-07-27, video lên nháp OK.)
 *
 * VÌ SAO KHÔNG CÓ BƯỚC "POSTER" RIÊNG như Instagram/Threads:
 *   Zernio VỪA nhận URL VỪA tự tải video lên TikTok trong một lời gọi (bất đồng bộ ~1–2 phút).
 *   Nên engine này VỪA tìm bài VỪA đẩy luôn — không cần bảng hàng đợi trung gian.
 *
 * ⚠️ CAPTION (CEO chốt): CHỈ điền sẵn HOOK (dòng đầu) + HASHTAG vào nháp. KHÔNG bê thân bài,
 *    KHÔNG bê khối chân ký (📍 địa chỉ / 📞 hotline) — trên TikTok trông kỳ cục. CEO tự hoàn thiện.
 *
 * ⚠️ MEDIA phải là URL CÔNG KHAI (Zernio cURL video từ URL). Lark cần đăng nhập ⇒ vô dụng.
 *    Cách gỡ (tái dùng y hệt engine Threads): đẩy video lên chính FB Page CỦA BÀI ĐÓ ở dạng
 *    published=false (không ai thấy) → lấy link CDN công khai Facebook → đưa Zernio → GIỮ cho tới
 *    khi Zernio tải xong rồi mới xoá (Zernio tải bất đồng bộ, xoá sớm là hụt).
 *
 * Đánh dấu chống trùng (KHÔNG đổi schema, giống bộ cột IG/Threads):
 *   - Đủ điều kiện xử lý ⇔ "TikTok Trạng thái" TRỐNG và "TikTok Log" TRỐNG.
 *   - Sau khi xử lý → "TikTok Trạng thái" = Thành công/Thất bại, "TikTok Log" = chi tiết + publish_id.
 *   - Bài cũ đã đóng dấu "Bỏ qua (cũ)" (hàng rào từ ngày mai) → không đụng.
 *
 * BIẾN MÔI TRƯỜNG:
 *   LARK_APP_ID, LARK_APP_SECRET, LARK_APP_TOKEN (=LARK_BASE_ID)              (bắt buộc)
 *   FB_POSTS_TABLE  = bảng 14.3 (nguồn)                                       (bắt buộc)
 *   ZERNIO_API_KEY  = khóa Zernio (Bearer)                                    (bắt buộc)
 *   ZERNIO_TIKTOK_BAU_ACCOUNT_ID / ZERNIO_BAU_PROFILE_ID       (mặc định đã nhúng)
 *   ZERNIO_TIKTOK_NEWBORN_ACCOUNT_ID / ZERNIO_NEWBORN_PROFILE_ID (mặc định đã nhúng)
 *   BAU_PAGE_ID (mặc định 252437297948793) · NEWBORN_PAGE_ID (mặc định 107291022310921)
 *   MAX_POSTS (mặc định 5) · LARK_DOMAIN · GRAPH_VERSION
 *   → Route nào THIẾU accountId thì bỏ qua page đó (vẫn chạy các route còn lại).
 *
 * Chạy:  node scripts/mirror-fb-to-tiktok.js
 *        node scripts/mirror-fb-to-tiktok.js --dry-run   (chỉ in kế hoạch, KHÔNG đẩy/ghi)
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const CFG = {
  APP_ID:     process.env.LARK_APP_ID       || '',
  APP_SECRET: process.env.LARK_APP_SECRET   || '',
  APP_TOKEN:  process.env.LARK_APP_TOKEN    || '',
  FB_TABLE:   process.env.FB_POSTS_TABLE    || '',
  ZKEY:       process.env.ZERNIO_API_KEY    || '',
  BAU_PAGE:   process.env.BAU_PAGE_ID       || '252437297948793',
  NB_PAGE:    process.env.NEWBORN_PAGE_ID   || '107291022310921',
  BAU_ACC:    process.env.ZERNIO_TIKTOK_BAU_ACCOUNT_ID     || '6a663b08542d8bc5a60ba6a7',
  BAU_PROF:   process.env.ZERNIO_BAU_PROFILE_ID            || '6a66397d09f56efe77297708',
  NB_ACC:     process.env.ZERNIO_TIKTOK_NEWBORN_ACCOUNT_ID || '6a664bc0542d8bc5a60d0938',
  NB_PROF:    process.env.ZERNIO_NEWBORN_PROFILE_ID        || '6a664b6e986dcd50f74547d8',
  MAX:        parseInt(process.env.MAX_POSTS || '5', 10),
  LARK_DOMAIN:process.env.LARK_DOMAIN       || 'https://open.larksuite.com',
  GRAPH:      'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v21.0'),
  ZBASE:      'https://zernio.com/api/v1',
};
const DRY = process.argv.includes('--dry-run');
const _m = [];
if(!CFG.APP_ID)     _m.push('LARK_APP_ID');
if(!CFG.APP_SECRET) _m.push('LARK_APP_SECRET');
if(!CFG.APP_TOKEN)  _m.push('LARK_APP_TOKEN (=LARK_BASE_ID)');
if(!CFG.FB_TABLE)   _m.push('FB_POSTS_TABLE (bảng 14.3)');
if(!CFG.ZKEY)       _m.push('ZERNIO_API_KEY');
if(_m.length){ console.error('!! Thiếu biến môi trường: '+_m.join(', ')); process.exit(1); }

// Bản đồ page → tài khoản TikTok. Route thiếu accountId sẽ bị loại (cho phép chạy 1 page khi page kia chưa nối).
const ROUTES = {};
if(CFG.BAU_ACC) ROUTES[CFG.BAU_PAGE] = { acc:CFG.BAU_ACC, prof:CFG.BAU_PROF, label:'Bầu' };
if(CFG.NB_ACC)  ROUTES[CFG.NB_PAGE]  = { acc:CFG.NB_ACC,  prof:CFG.NB_PROF,  label:'Newborn' };
if(!Object.keys(ROUTES).length){ console.error('!! Chưa khai accountId cho page nào (BAU/NEWBORN).'); process.exit(1); }

// Cột 14.3
const F = { caption:'Nội dung', hashtag:'Hastag', media:'Ảnh/video', status:'Trạng thái',
            fanpageId:'Fanpage ID', pageToken:'access_token',
            ttStatus:'TikTok Trạng thái', ttLog:'TikTok Log' };
const FB_DONE = 'Thành công', TT_DONE = 'Thành công', TT_FAIL = 'Thất bại';

const now   = () => new Date().toISOString().replace('T',' ').slice(0,19);
const log   = (...a) => console.log(now(), ...a);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const plain = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||x.name||'').join(''):(v.text||v.name||v.link||String(v));
const isVid = a => /\.(mp4|mov|m4v|webm)$/i.test(a.name||'') || /^video/i.test(a.type||'');

/* ---------- Lark (retry TooManyRequest 1254290 — bài học 26/07: thiếu retry là chết FATAL) ---------- */
async function larkApi(url, opt={}, label=''){
  for(let i=0;i<6;i++){
    let j;
    try{ const r=await fetch(url,{headers:{Authorization:'Bearer '+_tk,'Content-Type':'application/json; charset=utf-8'},...opt}); j=await r.json(); }
    catch(e){ if(i===5) throw new Error(`${label}: lỗi mạng sau 6 lần — ${e.message}`); await sleep(1500*(i+1)); continue; }
    if(j.code===0) return j;
    if(j.code===1254290){ await sleep(1500*(i+1)); continue; }
    throw new Error(`${label}: ${j.msg||JSON.stringify(j)} (code ${j.code})`);
  }
  throw new Error(`${label}: TooManyRequest quá nhiều lần`);
}
let _tk = '';
async function larkToken(){
  const r=await fetch(CFG.LARK_DOMAIN+'/open-apis/auth/v3/tenant_access_token/internal',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:CFG.APP_ID,app_secret:CFG.APP_SECRET})});
  const j=await r.json(); if(j.code!==0) throw new Error('Lark token: '+JSON.stringify(j));
  return j.tenant_access_token;
}
async function listAll(tableId){
  let items=[], pt='';
  do{ const j=await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records?page_size=200`+(pt?'&page_token='+pt:''), {}, 'list');
    items=items.concat(j.data.items||[]); pt=j.data.has_more?j.data.page_token:''; }while(pt);
  return items;
}
async function updateRow(tableId, recId, fields){
  await larkApi(`${CFG.LARK_DOMAIN}/open-apis/bitable/v1/apps/${CFG.APP_TOKEN}/tables/${tableId}/records/${recId}`,
    {method:'PUT', body:JSON.stringify({fields})}, 'update');
}
async function downloadMedia(fileToken, out){
  const tries=[ `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download?extra=${encodeURIComponent(JSON.stringify({bitablePerm:{tableId:CFG.FB_TABLE}}))}`,
                `${CFG.LARK_DOMAIN}/open-apis/drive/v1/medias/${fileToken}/download` ];
  for(const u of tries){ const r=await fetch(u,{headers:{Authorization:'Bearer '+_tk}});
    if(r.ok && (r.headers.get('content-type')||'').indexOf('json')<0){ const b=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(out,b); return b.length; } }
  throw new Error('không tải được video từ Lark ('+fileToken+')');
}

/* ---------- Mượn CDN Facebook để tạo URL công khai cho video (published=false) ----------
 * Upload lên CHÍNH Page của bài (pageId) bằng token của page đó → không phụ thuộc page nào cố định. */
async function fbApi(u,o){ const r=await fetch(u,o); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
  if(!r.ok||j.error) throw new Error('FB '+r.status+': '+JSON.stringify(j.error||j._raw)); return j; }
async function videoToPublicUrl(pageId, pageToken, file){
  const fd=new FormData();
  fd.set('access_token', pageToken); fd.set('published','false');
  fd.set('source', new Blob([fs.readFileSync(file)]), path.basename(file));
  const up=await fbApi(`${CFG.GRAPH}/${pageId}/videos`,{method:'POST',body:fd});
  if(!up.id) throw new Error('không upload được video tạm lên FB Page');
  for(let i=0;i<60;i++){   // FB cần vài phút xử lý video
    const s=await fbApi(`${CFG.GRAPH}/${up.id}?fields=source,status&access_token=${encodeURIComponent(pageToken)}`,{});
    const st=String((s.status && s.status.video_status)||'').toLowerCase();
    if(st==='ready' && s.source) return { url:s.source, videoId:up.id };
    if(st==='error') throw new Error('FB xử lý video tạm lỗi');
    await sleep(5000);
  }
  throw new Error('FB xử lý video tạm quá lâu (>5 phút)');
}
async function cleanupFb(pageToken, id){ try{ await fbApi(`${CFG.GRAPH}/${id}?access_token=${encodeURIComponent(pageToken)}`,{method:'DELETE'}); }catch{} }

/* ---------- Caption cho nháp TikTok: CHỈ hook (dòng đầu) + hashtag ---------- */
function captionForTikTok(content, hashtagCell){
  const lines = String(content||'').replace(/\r/g,'').split('\n').map(s=>s.trim());
  const hook = lines.find(l => l.length>0) || '';
  let tags = String(hashtagCell||'').trim();
  if(!tags){                                   // cột Hastag trống → nhặt hashtag trong nội dung
    const m = String(content||'').match(/#[^\s#]+/g);
    tags = m ? m.join(' ') : '';
  }
  return (hook + (tags ? '\n\n' + tags : '')).trim();
}

/* ---------- Zernio: nạp video vào NHÁP TikTok (Creator Inbox) của ĐÚNG tài khoản ---------- */
async function zernioDraft(caption, videoUrl, accId, profileId){
  const body = {
    content: caption,
    publishNow: true,                          // kích hoạt gửi sang TikTok (không giữ nháp Zernio)
    mediaItems: [{ type:'video', url:videoUrl }],
    platforms: [{ platform:'tiktok', accountId:accId }],
    ...(profileId ? { profileId } : {}),
    tiktokSettings: {
      draft: true,                             // ← "Send to Creator Inbox" = nháp trong app TikTok
      privacy_level:'PUBLIC_TO_EVERYONE', allow_comment:true, allow_duet:true, allow_stitch:true,
      content_preview_confirmed:true, express_consent_given:true, media_type:'video',
      auto_add_music:false, video_made_with_ai:false,
    },
  };
  const r = await fetch(CFG.ZBASE+'/posts',{method:'POST',headers:{Authorization:'Bearer '+CFG.ZKEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const t = await r.text(); let j; try{j=JSON.parse(t)}catch{j={_raw:t}}
  if(r.status>=400 || j.error) throw new Error('Zernio '+r.status+': '+JSON.stringify(j.error||j.message||j._raw||j).slice(0,300));
  const post = j.post || j;
  return { id: post._id || post.id, status: post.status };
}
// Chờ Zernio đẩy xong (để còn xoá video tạm). Trả về {ok, publishId, detail}.
async function zernioWait(postId){
  for(let i=0;i<40;i++){
    await sleep(6000);
    let pj; try{ const pr=await fetch(CFG.ZBASE+'/posts/'+postId,{headers:{Authorization:'Bearer '+CFG.ZKEY}}); pj=await pr.json(); }catch{ continue; }
    const p=pj.post||pj;
    const tt=(p.platforms||[]).find(x=>x.platform==='tiktok')||{};
    const pubId=(tt.platformSpecificData&&tt.platformSpecificData.tiktokPublishId)||'';
    const sP=String(p.status||''), sT=String(tt.status||'');
    if(['published','completed','success','sent'].includes(sP) || ['published','success'].includes(sT))
      return { ok:true, publishId:pubId, detail:sP+'/'+sT };
    if(['failed','error'].includes(sP) || ['failed','error'].includes(sT))
      return { ok:false, publishId:pubId, detail:(tt.error||tt.errorMessage||sP+'/'+sT) };
  }
  return { ok:false, publishId:'', detail:'quá lâu chưa xong' };
}

/* ================================ MAIN ================================ */
(async()=>{
  _tk = await larkToken();
  const rows = await listAll(CFG.FB_TABLE);
  log('Route đang bật: ' + Object.values(ROUTES).map(r=>r.label).join(', '));

  const cand = [];
  for(const row of rows){
    const f=row.fields;
    const pid=String(plain(f[F.fanpageId])||'').trim();
    const route=ROUTES[pid];
    if(!route) continue;                                                // page ngoài phạm vi (chưa nối TikTok)
    if(plain(f[F.status]).trim() !== FB_DONE) continue;                 // chưa đăng FB thành công
    if(plain(f[F.ttStatus]).trim()) continue;                          // đã có kết luận TikTok
    if(plain(f[F.ttLog]).trim())    continue;                          // đã xử lý / đã đánh dấu
    const atts=Array.isArray(f[F.media])?f[F.media]:[];
    const vid=atts.find(isVid);
    if(!vid) continue;                                                 // chỉ VIDEO
    const pageToken=plain(f[F.pageToken]).trim();
    if(!pageToken){
      if(!DRY) await updateRow(CFG.FB_TABLE, row.record_id, { [F.ttStatus]:TT_FAIL, [F.ttLog]:`[fail] ${now()} - thiếu access_token Page` });
      continue;
    }
    cand.push({ row, vid, pageId:pid, pageToken, route,
      caption: captionForTikTok(plain(f[F.caption]), plain(f[F.hashtag])) });
  }

  if(!cand.length){ log('Xong. Không có video mới đủ điều kiện nạp nháp TikTok.'); return; }
  const byLabel = cand.reduce((m,c)=>{m[c.route.label]=(m[c.route.label]||0)+1;return m;},{});
  log(`Ứng viên: ${cand.length} (${Object.entries(byLabel).map(([k,v])=>k+' '+v).join(', ')}). Xử tối đa ${CFG.MAX} lần chạy này.`);

  let done=0, fail=0;
  for(const c of cand){
    if(done+fail >= CFG.MAX){ log(`… dừng ở trần MAX_POSTS=${CFG.MAX}, phần còn lại để lượt sau.`); break; }
    const rid=c.row.record_id;
    log(`>> [${c.route.label}] ${rid} | ${c.vid.name} | "${c.caption.slice(0,36).replace(/\n/g,' ')}"`);
    if(DRY){ continue; }
    const tmp=path.join(os.tmpdir(), `tk_${rid}_${(c.vid.name||'v').replace(/[^\w.]/g,'')}`);
    let videoId=null;
    try{
      const sz=await downloadMedia(c.vid.file_token, tmp);
      log(`   tải video ${(sz/1e6).toFixed(1)}MB → mượn CDN Facebook (page ${c.pageId})…`);
      const pub=await videoToPublicUrl(c.pageId, c.pageToken, tmp); videoId=pub.videoId;
      log(`   URL công khai OK → đẩy vào nháp TikTok ${c.route.label}…`);
      const z=await zernioDraft(c.caption, pub.url, c.route.acc, c.route.prof);
      const w=await zernioWait(z.id);
      if(w.ok){
        await updateRow(CFG.FB_TABLE, rid, { [F.ttStatus]:TT_DONE, [F.ttLog]:`[done] ${now()} - nháp TikTok ${c.route.label} (${w.publishId||w.detail})` });
        done++; log(`   ✔ ĐÃ NẠP NHÁP TikTok ${c.route.label} (${w.publishId||w.detail})`);
      } else {
        await updateRow(CFG.FB_TABLE, rid, { [F.ttStatus]:TT_FAIL, [F.ttLog]:`[fail] ${now()} - Zernio: ${String(w.detail).slice(0,160)}` });
        fail++; log(`   ✖ THẤT BẠI: ${w.detail}`);
      }
    }catch(e){
      try{ await updateRow(CFG.FB_TABLE, rid, { [F.ttStatus]:TT_FAIL, [F.ttLog]:`[fail] ${now()} - ${String(e.message||e).slice(0,160)}` }); }catch{}
      fail++; log(`   ✖ LỖI: ${String(e.message||e).slice(0,160)}`);
    }finally{
      if(videoId) await cleanupFb(c.pageToken, videoId);   // xoá SAU khi Zernio đã tải xong
      try{ fs.unlinkSync(tmp); }catch{}
    }
  }
  log(`Xong. Nạp nháp: ${done}, Lỗi: ${fail}${cand.length>done+fail?`, còn ${cand.length-done-fail} chờ lượt sau`:''}.`);
})().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1); });
