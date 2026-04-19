'use strict';

// ── Constants ───────────────────────────────────────────────────────────────

const BASE_BITRATES = {
  '426x240':   0.4,
  '640x360':   1.0,
  '854x480':   2.5,
  '1280x720':  5.0,
  '1920x1080': 8.0,
  '2560x1440': 16.0,
  '3840x2160': 35.0,
  '7680x4320': 80.0,
};

// Hardware codec map: base CPU codec → hardware-accelerated equivalents
const HW_CODEC_MAP = {
  'libx264':    { nvgpu: 'h264_nvenc',  amdgpu: 'h264_amf',   intelgpu: 'h264_qsv'   },
  'libx265':    { nvgpu: 'hevc_nvenc',  amdgpu: 'hevc_amf',   intelgpu: 'hevc_qsv'   },
  'libvvenc':   { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'libvpx':     { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'libvpx-vp9': { nvgpu: null,          amdgpu: null,          intelgpu: 'vp9_qsv'    },
  'libsvtav1': { nvgpu: 'av1_nvenc',   amdgpu: 'av1_amf',    intelgpu: 'av1_qsv'    },
  'mpeg2video': { nvgpu: null,          amdgpu: null,          intelgpu: 'mpeg2_qsv'  },
  'mpeg4':      { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'libtheora':  { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'prores_ks':  { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'dnxhd':      { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'r10k':       { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'braw':       { nvgpu: null,          amdgpu: null,          intelgpu: null          },
  'rawvideo':   { nvgpu: null,          amdgpu: null,          intelgpu: null          },
};

// ── State ───────────────────────────────────────────────────────────────────

let currentCodecName   = 'H.265';
let currentCodecFactor = 0.55;
let currentFfCodec     = 'libx265';
let currentFfProfile   = null;
let currentHw          = 'cpu';
let currentPasses      = 1;
let currentOs          = 'linux';
let rawBitrate = 0, rawMin = 0, rawMax = 0;

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtBitrate(mbps) {
  if (mbps < 1) {
    const kb = mbps * 1000;
    return { num: kb.toFixed(0), unit: 'Kbit/s' };
  } else if (mbps < 1000) {
    return { num: mbps.toFixed(1), unit: 'Mbit/s' };
  } else {
    return { num: (mbps / 1000).toFixed(2), unit: 'Gbit/s' };
  }
}

function fmtBitrateShort(mbps) {
  const f = fmtBitrate(mbps);
  return `${f.num} ${f.unit}`;
}

// FFmpeg uses kbps integers: e.g. 8000k
function toFfmpegBitrate(mbps) {
  return `${Math.round(mbps * 1000)}k`;
}

function fmtSize(bytes) {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
  if (bytes >= 1e9)  return (bytes / 1e9).toFixed(1)  + ' GB';
  if (bytes >= 1e6)  return (bytes / 1e6).toFixed(0)  + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

// ── OS helpers ───────────────────────────────────────────────────────────────

function detectOs() {
  const ua = navigator.userAgent.toLowerCase();
  const pl = (navigator.platform || '').toLowerCase();
  if (pl.includes('win') || ua.includes('windows')) { console.log('[os] detected: windows'); return 'windows'; }
  if (pl.includes('mac') || ua.includes('macintosh') || ua.includes('mac os')) { console.log('[os] detected: mac'); return 'mac'; }
  console.log('[os] detected: linux (fallback)');
  return 'linux';
}

function setOsButton(os) {
  document.querySelectorAll('[data-os]').forEach(b => {
    b.classList.toggle('active', b.dataset.os === os);
  });
}

// Windows null device is NUL; Linux/macOS use /dev/null
function nullDevice() {
  return currentOs === 'windows' ? 'NUL' : '/dev/null';
}

// ── GPU detection ─────────────────────────────────────────────────────────────

// Uses WebGL renderer string — the most reliable client-side GPU hint available.
// Returns 'nvgpu' | 'amdgpu' | 'intelgpu' | 'cpu'
let rawGpuRenderer = '';

function detectGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'cpu';

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).toLowerCase()
      : gl.getParameter(gl.RENDERER).toLowerCase();
    rawGpuRenderer = renderer;
    console.log('[gpu] WebGL renderer:', renderer);

    if (renderer.includes('nvidia') || renderer.includes('geforce') || renderer.includes('quadro') || renderer.includes('nvenc')) { console.log('[gpu] detected: nvgpu'); return 'nvgpu'; }
    if (renderer.includes('amd') || renderer.includes('radeon') || renderer.includes('rx '))   { console.log('[gpu] detected: amdgpu'); return 'amdgpu'; }
    if (renderer.includes('intel') || renderer.includes('iris') || renderer.includes('uhd') || renderer.includes('hd graphics')) { console.log('[gpu] detected: intelgpu'); return 'intelgpu'; }
  } catch (e) { console.warn('[gpu] WebGL unavailable:', e.message); }
  console.log('[gpu] detected: cpu (fallback)');
  return 'cpu';
}

// AV1 hardware encoding support by generation:
// NVIDIA  — Ada (RTX 40xx) + Blackwell (RTX 50xx) only; RTX 30xx and below: decode only
// AMD     — RDNA 3 (RX 7xxx) + RDNA 4 (RX 9xxx) only; RX 6xxx and below: decode only
// Intel   — Arc discrete (Alchemist A-series, Battlemage B-series) only; iGPU (UHD/Iris): no encode
function isAv1HwEncodeSupported(hw, renderer) {
  if (hw === 'cpu') return true;
  const r = renderer;
  if (hw === 'nvgpu') {
    // RTX 40xx: matches "rtx 40", "4060","4070","4080","4090" etc.
    // RTX 50xx: matches "rtx 50", "5060","5070","5080","5090" etc.
    return /rtx\s*4\d|rtx\s*5\d|4[06789]\d0|5[05678]\d0/.test(r);
  }
  if (hw === 'amdgpu') {
    // RX 7xxx series (RDNA 3) or RX 9xxx (RDNA 4)
    return /rx\s*7\d{3}|rx\s*9\d{3}|radeon\s*7\d{2}m|radeon\s*8\d{2}m|radeon\s*890m|radeon\s*780m/.test(r);
  }
  if (hw === 'intelgpu') {
    // Arc A-series and B-series only
    return /arc|a[3578]\d0|b[35]\d0/.test(r);
  }
  return false;
}

function setHwButton(hw) {
  document.querySelectorAll('[data-hw]').forEach(b => {
    b.classList.toggle('active', b.dataset.hw === hw);
  });
}

// ── Codec resolution ─────────────────────────────────────────────────────────

function resolveCodec(baseCodec, hw) {
  if (hw === 'cpu') return baseCodec;
  const map = HW_CODEC_MAP[baseCodec];
  if (!map) return baseCodec;
  return map[hw] || baseCodec;
}

function isHwSupported(baseCodec, hw) {
  if (hw === 'cpu') return true;
  const map = HW_CODEC_MAP[baseCodec];
  return !!(map && map[hw]);
}

const HW_LABELS = { nvgpu: 'NVIDIA GPU', amdgpu: 'AMD GPU', intelgpu: 'Intel GPU' };

// ── Event handlers ───────────────────────────────────────────────────────────

function onResChange() {
  const val = document.getElementById('resolution').value;
  document.getElementById('customResWrap').style.display = val === 'custom' ? 'grid' : 'none';
  calculate();
}

function onFpsChange() {
  const val = document.getElementById('fps').value;
  document.getElementById('customFpsWrap').style.display = val === 'custom' ? 'grid' : 'none';
  calculate();
}

function selectCodec(btn) {
  document.querySelectorAll('.codec-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentCodecFactor = parseFloat(btn.dataset.factor);
  currentCodecName   = btn.dataset.codec;
  currentFfCodec     = btn.dataset.ffcodec;
  currentFfProfile   = btn.dataset.ffprofile || null;
  console.log(`[codec] ${currentCodecName} | ffcodec: ${currentFfCodec} | profile: ${currentFfProfile} | factor: ${currentCodecFactor}`);
  calculate();
}

function selectHw(btn) {
  document.querySelectorAll('[data-hw]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentHw = btn.dataset.hw;
  console.log(`[hw] selected: ${currentHw} | codec ${currentFfCodec} supported: ${isHwSupported(currentFfCodec, currentHw)}`);
  calculate();
}

function selectPass(btn) {
  document.querySelectorAll('[data-pass]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentPasses = parseInt(btn.dataset.pass);
  console.log(`[pass] ${currentPasses}-pass encoding`);
  calculate();
}

function selectOs(btn) {
  document.querySelectorAll('[data-os]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentOs = btn.dataset.os;
  calculate();
}

function setQuality(val, btn) {
  document.getElementById('quality').value = val;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  calculate();
}

function onSliderChange() {
  const q = parseInt(document.getElementById('quality').value);
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.q) === q);
  });
  calculate();
}

// ── Core calculation ─────────────────────────────────────────────────────────

function calculate() {
  const resSelect = document.getElementById('resolution').value;
  let width, height;
  if (resSelect === 'custom') {
    width  = parseInt(document.getElementById('customW').value) || 1920;
    height = parseInt(document.getElementById('customH').value) || 1080;
  } else {
    [width, height] = resSelect.split('x').map(Number);
  }

  const fpsRaw = document.getElementById('fps').value;
  const fps    = fpsRaw === 'custom'
    ? (parseInt(document.getElementById('customFps').value) || 60)
    : parseInt(fpsRaw);
  const quality = parseInt(document.getElementById('quality').value);

  const key         = `${width}x${height}`;
  const baseBitrate = BASE_BITRATES[key] ?? (8.0 * (width * height) / (1920 * 1080));

  const fpsFactor     = Math.pow(fps / 30, 0.75);
  const qualityFactor = 0.2 + (quality / 100) * 1.8;
  const bitrate       = baseBitrate * fpsFactor * qualityFactor * currentCodecFactor;
  console.log('[calc]', { resolution: key, fps, quality, baseBitrate, fpsFactor: +fpsFactor.toFixed(3), qualityFactor: +qualityFactor.toFixed(3), codecFactor: currentCodecFactor, bitrate_mbps: +bitrate.toFixed(3) });

  rawBitrate = bitrate;
  rawMin     = bitrate * 0.5;
  rawMax     = bitrate * 1.5;

  const bitsPerSec   = bitrate * 1_000_000;
  const bytesPerMin  = (bitsPerSec * 60) / 8;
  const bytesPerHour = bytesPerMin * 60;
  const pp = (width * height * fps) / 1_000_000;

  // Update result panel
  const mf = fmtBitrate(bitrate);
  document.getElementById('bitrateVal').textContent  = mf.num;
  document.getElementById('bitrateUnit').textContent = mf.unit;
  document.getElementById('bitrateMin').textContent  = fmtBitrateShort(rawMin);
  document.getElementById('bitrateMax').textContent  = fmtBitrateShort(rawMax);
  document.getElementById('sizePerMin').textContent  = fmtSize(bytesPerMin);
  document.getElementById('sizePerHour').textContent = fmtSize(bytesPerHour);
  document.getElementById('pixelsPerSec').textContent = pp >= 1000
    ? (pp / 1000).toFixed(1) + 'B'
    : pp.toFixed(1) + 'M';
  document.getElementById('codecName').textContent = currentCodecName;

  // Quality label with colour
  const steps = [
    [15,  'Very Low', '#ff3e6c'],
    [30,  'Low',      '#ff7a3e'],
    [50,  'Medium',   '#ffcc02'],
    [70,  'Good',     '#a8ff3e'],
    [85,  'High',     '#00ff9d'],
    [95,  'Ultra',    '#3e9eff'],
    [100, 'Lossless', '#c97fff'],
  ];
  const s  = steps.find(([t]) => quality <= t) || steps[steps.length - 1];
  const ql = document.getElementById('qualityLabel');
  ql.textContent = s[1];
  ql.style.color = s[2];

  // Info text
  const resLabel = resSelect === 'custom'
    ? `${width}×${height}`
    : resSelect.replace('x', '×');
  document.getElementById('infoText').textContent =
    `${resLabel} @ ${fps}fps · ${currentCodecName} · ${s[1]}. ` +
    `VBR range: ${fmtBitrateShort(rawMin)} – ${fmtBitrateShort(rawMax)}.`;

  updateFfmpegBlock(width, height);
  updateHwWarning();
}

// ── FFmpeg command builder ────────────────────────────────────────────────────

function buildCommandParts(width, height) {
  const bv   = toFfmpegBitrate(rawBitrate);
  const minV = toFfmpegBitrate(rawMin);
  const maxV = toFfmpegBitrate(rawMax);
  const buf  = toFfmpegBitrate(rawMax * 2); // bufsize = 2× maxrate

  const base    = currentFfCodec;
  const codec   = resolveCodec(base, currentHw);
  const profile = currentFfProfile;
  const hw      = currentHw;
  const passes  = currentPasses;
  const fpsRaw = document.getElementById('fps').value;
  const fpsVal = fpsRaw === 'custom'
    ? (parseInt(document.getElementById('customFps').value) || 60)
    : parseInt(fpsRaw);

  let pixFmt    = 'yuv420p';
  let outputExt = 'mp4';
  let extraPairs = []; // [['-flag', 'value'], ...]

  if (base === 'libx264' || codec === 'h264_nvenc' || codec === 'h264_amf' || codec === 'h264_qsv') {
    if      (hw === 'cpu')      extraPairs.push(['-preset', 'slow'],    ['-profile:v', 'high']);
    else if (hw === 'nvgpu')    extraPairs.push(['-preset', 'p6'],      ['-profile:v', 'high']);
    else if (hw === 'amdgpu')   extraPairs.push(['-quality', 'quality']);
    else if (hw === 'intelgpu') extraPairs.push(['-preset', 'veryslow']);
  } else if (base === 'libx265' || codec === 'hevc_nvenc' || codec === 'hevc_amf' || codec === 'hevc_qsv') {
    if      (hw === 'cpu')      extraPairs.push(['-preset', 'medium'],  ['-tag:v', 'hvc1']);
    else if (hw === 'nvgpu')    extraPairs.push(['-preset', 'p5'],      ['-tag:v', 'hvc1']);
    else if (hw === 'amdgpu')   extraPairs.push(['-quality', 'quality'],['-tag:v', 'hvc1']);
    else if (hw === 'intelgpu') extraPairs.push(['-preset', 'medium'],  ['-tag:v', 'hvc1']);
  } else if (base === 'libvvenc') {
    extraPairs.push(['-preset', 'medium']);
  } else if (base === 'libvpx') {
    extraPairs.push(['-quality', 'good'], ['-cpu-used', '2']);
    outputExt = 'webm';
  } else if (base === 'libvpx-vp9' || codec === 'vp9_qsv') {
    if (hw === 'cpu') extraPairs.push(['-quality', 'good'], ['-cpu-used', '2'], ['-row-mt', '1']);
    else              extraPairs.push(['-preset', 'medium']);
    outputExt = 'webm';
  } else if (base === 'libsvtav1' || codec === 'av1_nvenc' || codec === 'av1_amf' || codec === 'av1_qsv') {
    if      (hw === 'cpu')      extraPairs.push(['-cpu-used', '4'], ['-row-mt', '1']);
    else if (hw === 'nvgpu')    extraPairs.push(['-preset', 'p4']);
    else if (hw === 'amdgpu')   extraPairs.push(['-quality', 'quality']);
    else if (hw === 'intelgpu') extraPairs.push(['-preset', 'medium']);
    outputExt = 'mkv';
  } else if (base === 'prores_ks') {
    const profileMap = { lt: '1', standard: '2', hq: '3', '4444': '4', '4444xq': '5' };
    extraPairs.push(['-profile:v', profileMap[profile] || '3']);
    pixFmt = (profile === '4444' || profile === '4444xq') ? 'yuva444p10le' : 'yuv422p10le';
    outputExt = 'mov';
  } else if (base === 'dnxhd') {
    pixFmt = 'yuv422p';
    outputExt = 'mxf';
  } else if (base === 'mpeg2video' || codec === 'mpeg2_qsv') {
    extraPairs.push(['-g', '15'], ['-bf', '2']);
    outputExt = 'mpg';
  } else if (base === 'rawvideo') {
    pixFmt = 'rgb48le';
    outputExt = 'avi';
  } else if (base === 'libtheora') {
    outputExt = 'ogv';
  }

  const noVbr = base === 'libsvtav1' && hw === 'cpu';
  return { codec, pixFmt, outputExt, extraPairs, bv, minV, maxV, buf, fpsVal, hw, passes, noVbr };
}

function updateFfmpegBlock(width, height) {
  const d = buildCommandParts(width, height);
  const { codec, pixFmt, outputExt, extraPairs, bv, minV, maxV, buf, fpsVal, hw, passes, noVbr } = d;

  const T    = (cls, text) => `<span class="${cls}">${text}</span>`;
  const flag = t => T('tok-flag', t);
  const val  = t => T('tok-val', t);

  const buildPassLines = (passNum) => {
    const lines = [];

    let initPart = '';
    if      (hw === 'nvgpu')    initPart = `${flag('-hwaccel')} ${val('cuda')} `;
    else if (hw === 'amdgpu')   initPart = `${flag('-hwaccel')} ${val('d3d11va')} `;
    else if (hw === 'intelgpu') initPart = `${flag('-hwaccel')} ${val('qsv')} `;

    lines.push(`${T('tok-cmd', 'ffmpeg')} ${initPart}${flag('-i')} ${val('input.mp4')}`);
    lines.push(`  ${flag('-vcodec')} ${val(codec)}`);
    extraPairs.forEach(([f, v]) => lines.push(`  ${flag(f)} ${val(v)}`));
    lines.push(`  ${flag('-vf')} ${val(`scale=${width}:${height}`)}`);
    lines.push(`  ${flag('-r')} ${val(fpsVal)}`);
    lines.push(`  ${flag('-pix_fmt')} ${val(pixFmt)}`);

    if (passes === 2) {
      lines.push(`  ${flag('-pass')} ${val(String(passNum))}`);
      if (passNum === 1) lines.push(`  ${flag('-an')}`);
    }

    lines.push(`  ${flag('-b:v')} ${val(bv)}`);
    lines.push(`  ${flag('-minrate')} ${val(minV)}`);
    if (!noVbr) lines.push(`  ${flag('-maxrate')} ${val(maxV)}`);
    lines.push(`  ${flag('-bufsize')} ${val(buf)}`);

    if (passes === 1 || passNum === 2) {
      lines.push(`  ${flag('-acodec')} ${val('aac')} ${flag('-b:a')} ${val('192k')}`);
      lines.push(`  ${T('tok-file', `output.${outputExt}`)}`);
    } else {
      // Pass 1: discard output
      lines.push(`  ${flag('-f')} ${val(outputExt === 'webm' ? 'webm' : 'mp4')} ${T('tok-file', nullDevice())}`);
    }

    return lines.join('\n');
  };

  let html = '';
  if (passes === 1) {
    html = buildPassLines(1);
  } else {
    html  = T('tok-com', '# Pass 1') + '\n';
    html += buildPassLines(1);
    html += '\n\n';
    html += T('tok-com', '# Pass 2') + '\n';
    html += buildPassLines(2);
  }

  document.getElementById('ffmpegCode').innerHTML = html;
}

// ── Copy helpers ──────────────────────────────────────────────────────────────

function clipboardWrite(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = Object.assign(document.createElement('textarea'), {
    value: text,
    style: 'position:fixed;opacity:0',
  });
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function flashEl(id) {
  const el = document.getElementById(id);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Click main bitrate → copy as -b:v flag
function copyMain() {
  const text = `-b:v ${toFfmpegBitrate(rawBitrate)}`;
  console.log('[copy] bitrate flag:', text);
  clipboardWrite(text);
  flashEl('bitrateVal');
  showToast(`Copied: ${text}`);
}

// Click Min/Max stat cards → copy as -minrate / -maxrate flag
function copyStat(id, type) {
  const mbps = type === 'min' ? rawMin : rawMax;
  const flag = type === 'min' ? '-minrate' : '-maxrate';
  const text = `${flag} ${toFfmpegBitrate(mbps)}`;
  clipboardWrite(text);
  flashEl(id);
  showToast(`Copied: ${text}`);
}

// Build a clean single-line command (or two joined by &&) for clipboard
function buildPlainCommand(width, height) {
  const d = buildCommandParts(width, height);
  const { codec, pixFmt, outputExt, extraPairs, bv, minV, maxV, buf, fpsVal, hw, passes, noVbr } = d;

  const hwFlags = hw === 'nvgpu'    ? '-hwaccel cuda '
                : hw === 'amdgpu'   ? '-hwaccel d3d11va '
                : hw === 'intelgpu' ? '-hwaccel qsv '
                : '';
  const extras  = extraPairs.map(([f, v]) => `${f} ${v}`).join(' ');
  const base    = `ffmpeg ${hwFlags}-i input.mp4 -vcodec ${codec} ${extras} -vf scale=${width}:${height} -r ${fpsVal} -pix_fmt ${pixFmt}`;
  const tail    = noVbr
    ? `-b:v ${bv} -minrate ${minV} -bufsize ${buf}`
    : `-b:v ${bv} -minrate ${minV} -maxrate ${maxV} -bufsize ${buf}`;

  if (passes === 1) {
    return `${base} ${tail} -acodec aac -b:a 192k output.${outputExt}`.replace(/\s+/g, ' ').trim();
  }

  const p1 = `${base} -pass 1 -an ${tail} -f ${outputExt === 'webm' ? 'webm' : 'mp4'} ${nullDevice()}`.replace(/\s+/g, ' ').trim();
  const p2 = `${base} -pass 2 ${tail} -acodec aac -b:a 192k output.${outputExt}`.replace(/\s+/g, ' ').trim();
  return `${p1} && ${p2}`;
}

// Copy full ffmpeg command as one-liner
function copyFfmpeg() {
  const resSelect = document.getElementById('resolution').value;
  let width, height;
  if (resSelect === 'custom') {
    width  = parseInt(document.getElementById('customW').value) || 1920;
    height = parseInt(document.getElementById('customH').value) || 1080;
  } else {
    [width, height] = resSelect.split('x').map(Number);
  }

  const plain = buildPlainCommand(width, height);
  console.log('[copy] full command:', plain);
  clipboardWrite(plain);

  const btn = document.getElementById('ffmpegCopyBtn');
  btn.classList.add('flash');
  btn.textContent = '✓ Copied!';
  setTimeout(() => { btn.classList.remove('flash'); btn.textContent = '⎘ Copy command'; }, 1800);
  showToast('One-liner copied!');
}

// ── HW codec support warning ────────────────────────────────────────────────

function updateHwWarning() {
  const el = document.getElementById('hwWarn');
  if (!el) return;

  // General codec+hw compatibility check
  if (currentHw !== 'cpu' && !isHwSupported(currentFfCodec, currentHw)) {
    const msg = currentCodecName + ' does not support hardware encoding on ' + HW_LABELS[currentHw] +' - command generated for CPU encoder (' + currentFfCodec + ').';
    console.warn('[hw-warn] codec unsupported:', msg);
    el.querySelector('span').textContent = msg;
    el.style.display = 'flex';
    return;
  }

  // AV1-specific generation check (RTX 40+/50+, RX 7000+/9000+, Arc only)
  if (currentFfCodec === 'libsvtav1' && currentHw !== 'cpu' && rawGpuRenderer) {
    if (!isAv1HwEncodeSupported(currentHw, rawGpuRenderer)) {
      const genNote = {
        nvgpu:    'only RTX 40xx (Ada) and RTX 50xx (Blackwell)',
        amdgpu:   'only RX 7000 (RDNA 3) and RX 9000 (RDNA 4)',
        intelgpu: 'only Arc A-series and B-series (discrete GPUs)',
      }[currentHw] || '';
      const msg = 'AV1 encode: Your ' + HW_LABELS[currentHw] + ' generation does not support AV1 hardware encoding (' + genNote + ').';
      console.warn('[hw-warn] AV1 gen unsupported:', msg);
      el.querySelector('span').textContent = msg;
      el.style.display = 'flex';
      return;
    }
  }

  el.style.display = 'none';
}

// ── Init ──────────────────────────────────────────────────────────────────────

currentOs = detectOs();
setOsButton(currentOs);

currentHw = detectGpu();
setHwButton(currentHw);

console.log('[init] Bitrate Calculator ready | os:', currentOs, '| hw:', currentHw);
calculate();