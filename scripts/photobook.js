'use strict';
/*
 * photobook.js — Ghép NHIỀU ẢNH của một bài thành MỘT TRANG DÀN ẢNH (photobook)
 *                rồi trả về đúng 1 file để engine đăng như ảnh đơn.
 *
 * VÌ SAO CẦN: Facebook chỉ hiện nguyên vẹn ảnh khi bài có ĐÚNG 1 ẢNH. Từ 2 ảnh trở lên
 * nó tự dựng "collage" với các ô cố định và CẮT GIỮA (center-crop) mỗi ảnh cho vừa ô —
 * ảnh dọc chân dung vào ô vuông là mất đầu, mất chân. Từ ảnh thứ 5 trở đi còn bị giấu
 * hẳn sau badge "+N", không ai nhìn thấy.
 *
 * CÁCH CHỮA: mình tự dàn trang TRƯỚC thành một tấm duy nhất, rồi đăng tấm đó qua nhánh
 * 1-ảnh (`/photos`). Facebook không còn cớ ghép collage ⇒ hiện nguyên vẹn 100%.
 *
 * BA NGUYÊN TẮC THIẾT KẾ:
 *  1. KHÔNG CẮT ẢNH — mỗi ảnh dùng `object-fit: contain`, nằm TRỌN trong ô của nó như
 *     một tấm ảnh in được bo khung trắng dán lên trang. Ô rộng hơn ảnh thì dư ra nền,
 *     chứ tuyệt đối không gọt vào ảnh. Đây là điểm khác cốt lõi so với collage Facebook.
 *  2. MÀU NỀN LẤY TỪ CHÍNH BỘ ẢNH — đọc màu trung bình của các ảnh rồi hạ bão hòa,
 *     kéo sáng (hoặc kéo tối nếu bộ ảnh tông trầm) thành màu nền hài hòa. Ảnh tông kem
 *     ra nền kem, tông xanh ra nền xanh nhạt — không bao giờ chỏi màu.
 *  3. TỶ LỆ TRANG NẰM TRONG VÙNG AN TOÀN của Facebook: cao nhất 4:5 (1080×1350), thấp
 *     nhất 1:1 (1080×1080). Ra ngoài khoảng này là chính tấm ghép lại bị Facebook cắt.
 *
 * KHÔNG PHỤ THUỘC THƯ VIỆN NGOÀI: đọc kích thước ảnh bằng cách tự phân tích header
 * JPEG/PNG/WebP, dàn trang bằng HTML/CSS, chụp bằng Chrome headless (runner
 * `ubuntu-latest` của GitHub đã cài sẵn Google Chrome; máy Windows dùng Chrome đã cài).
 * Chuyển PNG→JPEG bằng ffmpeg NẾU có, để tấm ghép nhẹ dưới trần 4MB của Facebook.
 *
 * AN TOÀN: mọi lỗi (không thấy Chrome, chụp hỏng, ảnh lạ…) đều KHÔNG làm chết lượt đăng —
 * hàm trả về nguyên danh sách file gốc và engine đăng theo cách cũ. Dàn trang là phần
 * làm đẹp thêm, không được phép trở thành mắt xích gãy.
 */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const W = 1080;                 // bề ngang trang, cố định — đúng bề ngang ảnh feed Facebook
const H_MIN = 1080;             // 1:1  — thấp nhất, dưới nữa thì bài chiếm quá ít màn hình
const H_MAX = 1350;             // 4:5  — cao nhất Facebook cho phép, quá nữa là bị cắt
const PAD = 48;                 // lề ngoài trang
const GAP = 22;                 // rãnh giữa các ô ảnh
const FOOT = 78;                // dải chân trang (tên studio)
const MAX_ANH = 6;              // quá số này thì ô nhỏ tới mức không nhìn ra mặt người
const RATIO_MAC_DINH = 2 / 3;   // ảnh studio thường là ảnh dọc 2:3 — dùng khi không đọc được kích thước

// Số ô MỘT HÀNG theo số ảnh của nhóm. Hàng thiếu ô được canh giữa, và mọi ô trong
// cùng một nhóm đều CÙNG KHỔ (như các tấm ảnh in cùng cỡ dán trên một trang).
// Ảnh ngang thưa hơn ảnh dọc: 3 ảnh ngang một hàng thì mỗi tấm dẹt và bé quá.
const O_MOI_HANG_DOC   = { 1:1, 2:2, 3:3, 4:2, 5:3, 6:3 };
const O_MOI_HANG_NGANG = { 1:1, 2:2, 3:2, 4:2, 5:3, 6:3 };
const LA_NGANG = r => r >= 0.95;   // vuông tính là ngang — nó xếp cùng ảnh ngang thì hợp hơn

// ── Đọc kích thước ảnh từ header, không cần thư viện giải mã ảnh ───────────────
function kichThuocJpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (i + 3 >= b.length) break;
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 (trừ DHT 0xC4, JPG 0xC8, DAC 0xCC) là nơi khai chiều cao/rộng thật
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}
function kichThuoc(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length > 24 && b[0] === 0xFF && b[1] === 0xD8) return kichThuocJpeg(b);
    if (b.length > 24 && b.toString('ascii', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const c = b.toString('ascii', 12, 16);
      if (c === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xFFFFFF) + 1, h: (b.readUIntLE(27, 3) & 0xFFFFFF) + 1 };
      if (c === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF };
      if (c === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3FFF) + 1, h: ((n >> 14) & 0x3FFF) + 1 }; }
    }
  } catch { }
  return null;
}

// ── Tìm Chrome ────────────────────────────────────────────────────────────────
function timChrome() {
  const ung = [process.env.CHROME_PATH, process.env.PHOTOBOOK_CHROME,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser',
    '/usr/bin/chromium', '/snap/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const p of ung) { try { if (fs.existsSync(p)) return p; } catch { } }
  return null;
}
function timFfmpeg() {
  const ung = [process.env.VSS_FFMPEG, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const p of ung) {
    try { const r = cp.spawnSync(p, ['-version'], { timeout: 8000 }); if (r.status === 0) return p; } catch { }
  }
  return null;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fileUrl = p => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\/+/, '')
  .split('/').map(encodeURIComponent).join('/');

const trungVi = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : RATIO_MAC_DINH;

/*
 * Tính hình học trang. Trả về { H, hang: [{ o:[chỉ số ảnh], cellW, cellH }] }.
 *
 * Ý đồ: ô to nhất có thể mà trang vẫn nằm trong khoảng an toàn 1:1 → 4:5.
 *
 * ⚠️ ĐIỂM QUAN TRỌNG NHẤT — GOM ẢNH CÙNG HƯỚNG VÀO CÙNG HÀNG.
 * Bộ ảnh thật của studio hầu như luôn trộn ảnh dọc với ảnh ngang. Nếu xếp lẫn
 * vào một lưới ô đồng khổ, ảnh ngang lọt vào ô dọc chỉ cao bằng nửa ô ⇒ nó
 * "trôi lửng lơ" giữa mảng nền trống, trang mất ngăn nắp. Gặp thật ở dòng
 * recvrP2VYBpaPa (3 ảnh dọc + 2 ảnh ngang) khi chạy thử 2026-08-10.
 * Photobook in thật không xếp vậy: ảnh cùng hướng đi cùng hàng, mỗi hàng có
 * chiều cao riêng theo đúng tỷ lệ của hàng đó ⇒ mọi ảnh lấp KHÍT ô của mình.
 *
 * Chiều cao hàng lấy theo tỷ lệ TRUNG VỊ của chính hàng đó — trung vị chứ không
 * phải trung bình, để một tấm lệch cỡ không kéo cả hàng.
 */
function hinhHoc(tyLes) {
  const idxDoc = [], idxNgang = [];
  tyLes.forEach((r, i) => (LA_NGANG(r) ? idxNgang : idxDoc).push(i));

  // Nhóm nào có ảnh đầu tiên thì lên trên — giữ được cảm giác thứ tự CEO xếp trong Lark.
  const nhom = [];
  if (idxDoc.length && idxNgang.length) {
    const truoc = idxDoc[0] < idxNgang[0];
    nhom.push({ idx: truoc ? idxDoc : idxNgang, ngang: !truoc });
    nhom.push({ idx: truoc ? idxNgang : idxDoc, ngang: truoc });
  } else {
    const chi = idxDoc.length ? idxDoc : idxNgang;
    nhom.push({ idx: chi, ngang: !idxDoc.length });
  }

  const hang = [];
  for (const g of nhom) {
    const m = g.idx.length;
    const per = (g.ngang ? O_MOI_HANG_NGANG : O_MOI_HANG_DOC)[m] || 3;
    const cellW = Math.floor((W - 2 * PAD - (per - 1) * GAP) / per);
    const cellH = Math.round(cellW / trungVi(g.idx.map(i => tyLes[i])));
    for (let k = 0; k < m; k += per) hang.push({ o: g.idx.slice(k, k + per), cellW, cellH });
  }

  const tongO = () => hang.reduce((s, h) => s + h.cellH, 0);
  let H = 2 * PAD + tongO() + (hang.length - 1) * GAP + FOOT;
  if (H > H_MAX) {                      // trang cao quá → thu chiều cao ô cho vừa
    const cho = H_MAX - 2 * PAD - FOOT - (hang.length - 1) * GAP;
    const k = cho / tongO();            // ô dẹt lại nhưng ảnh vẫn `contain` ⇒ KHÔNG cắt, chỉ dư nền hai bên
    hang.forEach(h => { h.cellH = Math.floor(h.cellH * k); });
    H = H_MAX;
  } else if (H < H_MIN) {               // trang thấp quá → nâng lên 1:1, phần dư thành lề quanh ảnh
    H = H_MIN;
  }
  return { H, hang };
}

function dungHtml(files, geo, tenChan, phuChan) {
  let html = '';
  for (const h of geo.hang) {
    html += '<div class="row">';
    for (const i of h.o) {
      html += `<div class="cell" style="width:${h.cellW}px;height:${h.cellH}px">` +
              `<img src="${esc(fileUrl(files[i].path))}"></div>`;
    }
    html += '</div>';
  }
  const chan = tenChan
    ? `<div class="foot"><div class="rule"></div><div class="name">${esc(tenChan)}</div>` +
      (phuChan ? `<div class="sub">${esc(phuChan)}</div>` : '') + '</div>'
    : '<div class="foot"></div>';

  return `<!doctype html><html lang="vi"><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W}px;height:${geo.H}px;overflow:hidden}
  body{background:var(--mat,#FAF7F2);
       font-family:'Noto Serif','DejaVu Serif','Liberation Serif',Georgia,serif}
  .page{box-sizing:border-box;width:${W}px;height:${geo.H}px;padding:${PAD}px;
        display:flex;flex-direction:column}
  .stage{flex:1;display:flex;flex-direction:column;justify-content:center;gap:${GAP}px}
  .row{display:flex;justify-content:center;gap:${GAP}px}
  .cell{display:flex;align-items:center;justify-content:center}   /* kích thước đặt inline theo từng hàng */
  /* contain = ảnh nằm TRỌN trong ô, không bao giờ bị gọt.
     box-shadow spread 7px = khung trắng ôm SÁT mép ảnh thật (không phải mép ô),
     nên ảnh dọc hay ngang đều ra dáng một tấm ảnh in được bo khung. */
  .cell img{max-width:100%;max-height:100%;width:auto;height:auto;display:block;
            box-shadow:0 0 0 7px var(--khung,#fff), 0 3px 12px rgba(0,0,0,.15)}
  .foot{height:${FOOT}px;display:flex;flex-direction:column;
        align-items:center;justify-content:flex-end;gap:9px}
  .rule{width:56px;height:2px;background:var(--nhan,#B08D57);opacity:.65}
  .name{font-size:27px;line-height:1.1;color:var(--muc,#3B3630)}
  /* CỐ Ý KHÔNG dùng text-transform:uppercase — chữ HOA tiếng Việt có dấu hỏi/nặng
     (Ụ, Ả…) thiếu glyph ở nhiều font hệ thống, render ra mất dấu hoặc sai dấu
     ("CHỤP ẢNH" thành "CHUP ÃNH"). Chữ thường thì font nào cũng đủ. */
  .sub{font-size:16px;line-height:1;letter-spacing:.14em;
       color:var(--muc,#3B3630);opacity:.62;
       font-family:'Segoe UI','Noto Sans','DejaVu Sans','Liberation Sans',Arial,sans-serif}
  </style><body><div class="page"><div class="stage">${html}</div>${chan}</div>
  <script>
  // Lấy màu nền TỪ CHÍNH BỘ ẢNH: vẽ mỗi ảnh xuống canvas 24x24 rồi lấy màu trung bình.
  // Ảnh nạp bằng file:// nên cần cờ --allow-file-access-from-files thì canvas mới đọc được;
  // đọc không được (canvas bị "nhuốm bẩn") thì rơi về bảng màu kem mặc định trong CSS.
  function rgb2hsl(r,g,b){r/=255;g/=255;b/=255;
    var mx=Math.max(r,g,b),mn=Math.min(r,g,b),h=0,s=0,l=(mx+mn)/2,d=mx-mn;
    if(d){s=l>.5?d/(2-mx-mn):d/(mx+mn);
      h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4);h/=6;}
    return [h*360,s,l];}
  function hsl(h,s,l){return 'hsl('+h.toFixed(1)+','+(s*100).toFixed(1)+'%,'+(l*100).toFixed(1)+'%)';}
  function to(){
    try{
      var ims=[].slice.call(document.images).filter(function(i){return i.naturalWidth>0});
      if(!ims.length) return;
      var c=document.createElement('canvas');c.width=24;c.height=24;
      var x=c.getContext('2d',{willReadFrequently:true});
      var R=0,G=0,B=0,N=0;
      for(var k=0;k<ims.length;k++){
        x.clearRect(0,0,24,24); x.drawImage(ims[k],0,0,24,24);
        var d=x.getImageData(0,0,24,24).data;
        for(var i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];N++;}
      }
      if(!N) return;
      var p=rgb2hsl(R/N,G/N,B/N), h=p[0], s=p[1], l=p[2];
      var toi = l < 0.34;                       // bộ ảnh tông trầm → trang nền tối cho hợp
      var st=document.documentElement.style;
      // Nền phải ĐỦ ĐẬM hơn khung trắng quanh ảnh, không thì khung chìm mất và
      // trang nhìn như một mảng trắng loang. .925 là mức vừa: vẫn sáng như giấy in,
      // vẫn tách được khỏi nền trắng của giao diện Facebook.
      st.setProperty('--mat',  toi?hsl(h,Math.min(s,.22),.13):hsl(h,Math.min(s,.40)*.75+.04,.925));
      st.setProperty('--muc',  toi?hsl(h,.10,.90):hsl(h,.20,.24));
      st.setProperty('--nhan', hsl(h,Math.min(Math.max(s,.24),.52),toi?.64:.46));
      st.setProperty('--khung',toi?hsl(h,.06,.97):'#ffffff');
    }catch(e){}
  }
  window.addEventListener('load',to); to();
  </script></body></html>`;
}

/*
 * build(files, opt) — files: [{path,name}] đã tải sẵn về máy.
 * Trả về MẢNG FILE MỚI để đăng:
 *   - thành công → [ { path: <trang ghép>, name: 'photobook.jpg' } ]  (đúng 1 file)
 *   - không áp dụng / lỗi → chính `files` ban đầu (engine đăng như cũ)
 * opt: { footer, tag, tmp, log }   tmp = mảng để engine dọn file tạm ở finally.
 */
async function build(files, opt) {
  const ghi = (opt && opt.log) || (() => { });
  const tmp = (opt && opt.tmp) || [];
  if (process.env.PHOTOBOOK === 'false' || process.env.PHOTOBOOK === '0') return files;
  if (!Array.isArray(files) || files.length < 2) return files;      // 1 ảnh vốn đã không bị cắt

  const chrome = timChrome();
  if (!chrome) { ghi('     ! không tìm thấy Chrome → giữ nguyên kiểu đăng nhiều ảnh'); return files; }

  let dung = files;
  if (files.length > MAX_ANH) {
    dung = files.slice(0, MAX_ANH);
    ghi(`     ! ${files.length} ảnh vượt mức đẹp — dàn ${MAX_ANH} tấm đầu, bỏ ${files.length - MAX_ANH} tấm cuối`);
  }

  // Tỷ lệ TỪNG ảnh (không gộp thành một con số) — hinhHoc() cần biết ảnh nào dọc,
  // ảnh nào ngang để gom cùng hướng vào cùng hàng.
  const tyLes = dung.map(f => {
    const k = kichThuoc(f.path);
    const r = k && k.w && k.h ? k.w / k.h : RATIO_MAC_DINH;
    return Math.min(Math.max(r, 0.5), 1.9);              // chặn ảnh panorama/siêu dài làm vỡ bố cục
  });
  const geo = hinhHoc(tyLes);

  // normalize('NFC') — tên page lấy từ Lark có thể ở dạng dấu rời (NFD); gộp về dạng
  // dựng sẵn thì font hệ thống mới bắt đúng glyph, không bị rơi dấu.
  const ten = String((opt && opt.footer) || '').normalize('NFC').trim();
  const cat = ten.split(/\s[-–—]\s/);
  const tenChan = (cat[0] || '').trim(), phuChan = cat.slice(1).join(' - ').trim();

  const nen = String((opt && opt.tag) || 'pb').replace(/[^\w]/g, '');
  const fHtml = path.join(os.tmpdir(), `pb_${nen}_${process.pid}.html`);
  const fPng = path.join(os.tmpdir(), `pb_${nen}_${process.pid}.png`);
  const fJpg = path.join(os.tmpdir(), `pb_${nen}_${process.pid}.jpg`);
  tmp.push(fHtml, fPng, fJpg);

  try {
    fs.writeFileSync(fHtml, dungHtml(dung, geo, tenChan, phuChan), 'utf8');
    const r = cp.spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      '--allow-file-access-from-files',          // để canvas đọc được ảnh file:// mà tính màu nền
      '--virtual-time-budget=20000',             // chờ ảnh nạp + script đổi màu xong mới chụp
      `--window-size=${W},${geo.H}`,
      `--screenshot=${fPng}`, fileUrl(fHtml),
    ], { timeout: 120000, stdio: 'ignore' });

    if (!fs.existsSync(fPng) || fs.statSync(fPng).size < 5000) {
      ghi(`     ! dàn trang hỏng (chrome status=${r.status}) → giữ nguyên kiểu đăng nhiều ảnh`);
      return files;
    }

    // PNG ảnh chụp rất nặng; Facebook chặn ảnh quá lớn. Có ffmpeg thì đổi sang JPEG.
    let out = fPng, tenOut = 'photobook.png';
    const ff = timFfmpeg();
    if (ff) {
      const c = cp.spawnSync(ff, ['-y', '-loglevel', 'error', '-i', fPng, '-q:v', '2', fJpg],
        { timeout: 120000, stdio: 'ignore' });
      if (c.status === 0 && fs.existsSync(fJpg) && fs.statSync(fJpg).size > 5000) { out = fJpg; tenOut = 'photobook.jpg'; }
    }
    const kb = Math.round(fs.statSync(out).size / 1024);
    if (fs.statSync(out).size > 3.8 * 1024 * 1024) {
      ghi(`     ! trang ghép nặng ${kb}KB (>3.8MB) → giữ nguyên kiểu đăng nhiều ảnh cho chắc`);
      return files;
    }
    ghi(`     ▣ dàn trang photobook: ${dung.length} ảnh → 1 tấm ${W}×${geo.H} (${kb}KB)`);
    return [{ path: out, name: tenOut }];
  } catch (e) {
    ghi(`     ! dàn trang lỗi: ${String(e.message || e).slice(0, 140)} → giữ nguyên kiểu đăng nhiều ảnh`);
    return files;
  }
}

module.exports = { build, kichThuoc, hinhHoc, MAX_ANH };
