'use strict';

/* =====================================================================
 * 프로토콜 정의 (firmware/protocol.h 와 반드시 동일하게 유지)
 *
 *  [0xA5][0x5A][TYPE][LEN][PAYLOAD x LEN][CRC8]
 *   CRC8: poly 0x07, init 0x00, TYPE부터 PAYLOAD 끝까지
 *
 *  MCU -> PC
 *   0x01 DATA   : seq u16 LE, 그 뒤 N개의 샘플 세트 (각 세트 = 4ch x u16 LE)
 *                 LEN = 2 + 8*N
 *   0x02 STATUS : rate u32 LE, running u8, channels u8, batch u8   (LEN=7)
 *   0x03 TEXT   : ASCII 디버그 문자열
 *  PC -> MCU
 *   0x10 START, 0x11 STOP, 0x13 GET_STATUS  (LEN=0)
 *   0x12 SET_RATE : rate u32 LE (LEN=4)
 * ===================================================================== */
const SYNC1 = 0xA5, SYNC2 = 0x5A;
const T_DATA = 0x01, T_STATUS = 0x02, T_TEXT = 0x03;
const T_START = 0x10, T_STOP = 0x11, T_SET_RATE = 0x12, T_GET_STATUS = 0x13;
const CH = 4;
const BYTES_PER_SET = 2 * CH;

function crc8(bytes, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= bytes[i];
    for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
  }
  return c;
}

function encodeFrame(type, payload = new Uint8Array(0)) {
  const f = new Uint8Array(5 + payload.length);
  f[0] = SYNC1; f[1] = SYNC2; f[2] = type; f[3] = payload.length;
  f.set(payload, 4);
  f[4 + payload.length] = crc8(f, 2, 4 + payload.length);
  return f;
}

function u32le(v) {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, v >>> 0, true);
  return p;
}

/* 스트림 -> 프레임 파서. 프레임 중간부터 수신을 시작해도 동기 바이트로 복구한다. */
class FrameParser {
  constructor(onFrame) {
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
    this.onFrame = onFrame;
    this.crcErrors = 0;
    this.skipped = 0;
    this.lastFeed = 0;
  }
  /* forceSkip: 잘못된 동기로 긴 프레임을 기다리는 상태를 풀기 위해 첫 바이트를 버리고 재탐색 */
  feed(chunk, forceSkip = false) {
    if (this.len + chunk.length > this.buf.length) {
      // 처리 못 한 데이터가 너무 쌓이면 버린다 (비정상 상태)
      this.len = 0;
      this.skipped += chunk.length;
      if (chunk.length > this.buf.length) return;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    if (chunk.length) this.lastFeed = performance.now();

    let i = (forceSkip && this.len > 0) ? 1 : 0;
    const buf = this.buf;
    while (true) {
      while (i + 1 < this.len && !(buf[i] === SYNC1 && buf[i + 1] === SYNC2)) { i++; this.skipped++; }
      if (i + 4 > this.len) break;
      const type = buf[i + 2], plen = buf[i + 3];
      const total = 5 + plen;
      if (i + total > this.len) break;
      if (crc8(buf, i + 2, i + 4 + plen) === buf[i + 4 + plen]) {
        this.onFrame(type, buf.subarray(i + 4, i + 4 + plen));
        i += total;
      } else {
        this.crcErrors++;
        i += 1;
      }
    }
    if (i > 0) { buf.copyWithin(0, i, this.len); this.len -= i; }
  }
}

/* =====================================================================
 * 링 버퍼: 채널별 raw 값 저장
 * ===================================================================== */
class RingStore {
  constructor(cap) {
    this.cap = cap;
    this.ch = Array.from({ length: CH }, () => new Uint16Array(cap));
    this.head = 0;   // 다음 쓰기 위치
    this.count = 0;  // 저장된 샘플 수
    this.total = 0;  // 누적 샘플 수 (시간축 기준)
  }
  push(payload, off) {
    const h = this.head;
    for (let c = 0; c < CH; c++) this.ch[c][h] = payload[off + 2 * c] | (payload[off + 2 * c + 1] << 8);
    this.head = (h + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.total++;
  }
  clear() { this.head = 0; this.count = 0; this.total = 0; }
  /* 최근 n개 중 k번째 (0 = 가장 오래된) 샘플의 채널 c 값 */
  at(c, n, k) {
    const idx = (this.head - n + k + this.cap * 2) % this.cap;
    return this.ch[c][idx];
  }
}

/* =====================================================================
 * 전송 계층: Web Serial
 *   connect(baud), write(Uint8Array), disconnect(), onData(Uint8Array), onClose()
 * ===================================================================== */
class SerialTransport {
  constructor() { this.port = null; this.reader = null; this.writer = null; this.onData = null; this.onClose = null; this.readDone = null; }
  async connect(baud) {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, bufferSize: 1 << 16 });
    this.writer = this.port.writable.getWriter();
    this.readDone = this.readLoop();
  }
  async readLoop() {
    try {
      while (this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && this.onData) this.onData(value);
          }
        } catch (e) {
          log('수신 오류: ' + e.message);
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
        if (this.closing) break;
      }
    } finally {
      if (this.onClose) this.onClose();
    }
  }
  async write(bytes) { if (this.writer) await this.writer.write(bytes); }
  async disconnect() {
    this.closing = true;
    try { if (this.reader) await this.reader.cancel(); } catch (_) {}
    try { if (this.writer) { this.writer.releaseLock(); this.writer = null; } } catch (_) {}
    try { await this.readDone; } catch (_) {}
    try { await this.port.close(); } catch (e) { log('포트 닫기 실패: ' + e.message); }
  }
}

/* =====================================================================
 * 앱 상태
 * ===================================================================== */
const $ = (id) => document.getElementById(id);
const store = new RingStore(1 << 20);   // 채널당 1M 샘플
const state = {
  transport: null, connected: false, running: false, paused: false,
  mcuRate: 0, requestedRate: 1000,
  frames: 0, dropped: 0, lastSeq: -1, bytes: 0,
  rateHist: [], byteHist: [], dirty: false,
};

function log(msg) {
  const el = $('log');
  const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  el.textContent += `[${ts}] ${msg}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > 300) el.textContent = lines.slice(-300).join('\n');
  el.scrollTop = el.scrollHeight;
}

const parser = new FrameParser(onFrame);

function onFrame(type, p) {
  if (type === T_DATA) {
    if (p.length < 2 || ((p.length - 2) % BYTES_PER_SET) !== 0) return;
    const seq = p[0] | (p[1] << 8);
    if (state.lastSeq >= 0) {
      const gap = (seq - state.lastSeq - 1) & 0xFFFF;
      if (gap) state.dropped += gap;
    }
    state.lastSeq = seq;
    state.frames++;
    const n = (p.length - 2) / BYTES_PER_SET;
    for (let i = 0; i < n; i++) store.push(p, 2 + i * BYTES_PER_SET);
    state.dirty = true;
  } else if (type === T_STATUS) {
    if (p.length < 7) return;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const rate = dv.getUint32(0, true);
    const running = !!p[4];
    if (rate !== state.mcuRate) { state.mcuRate = rate; store.clear(); state.lastSeq = -1; buildPlot(); }
    state.running = running;
    log(`STATUS: rate=${rate} Hz, running=${running}, ch=${p[5]}, batch=${p[6]}`);
    updateButtons();
  } else if (type === T_TEXT) {
    log('MCU: ' + new TextDecoder().decode(p));
  }
}

async function send(type, payload) {
  if (!state.transport) return;
  try { await state.transport.write(encodeFrame(type, payload)); }
  catch (e) { log('송신 실패: ' + e.message); }
}

/* ---------------- 연결 ---------------- */
async function connect() {
  const baud = +$('baud').value;
  if (!('serial' in navigator)) { $('serialWarn').classList.remove('hidden'); return; }
  const t = new SerialTransport();
  t.onData = (chunk) => { state.bytes += chunk.length; parser.feed(chunk); };
  t.onClose = () => { if (state.connected) { state.connected = false; state.running = false; state.transport = null; log('연결 종료'); updateButtons(); } };
  try {
    await t.connect(baud);
  } catch (e) {
    log('연결 실패: ' + e.message);
    return;
  }
  state.transport = t; state.connected = true;
  state.frames = 0; state.dropped = 0; state.lastSeq = -1; state.bytes = 0;
  parser.crcErrors = 0; parser.skipped = 0; parser.len = 0;
  store.clear();
  log(`시리얼 포트 열림 (${baud} bps)`);
  updateButtons();
  await send(T_GET_STATUS);
}

async function disconnect() {
  if (!state.transport) return;
  const t = state.transport;
  if (state.running) await send(T_STOP);
  state.connected = false; state.running = false; state.transport = null;
  await t.disconnect();
  log('연결 해제');
  updateButtons();
}

/* ---------------- UI ---------------- */
function selectedRate() {
  const sel = $('rateSel').value;
  const v = sel === 'custom' ? +$('rateCustom').value : +sel;
  return Math.max(1, Math.min(200000, Math.round(v || 0)));
}

function maxRateForBaud(baud, batch = 16) {
  const bytesPerSet = (5 + 2 + BYTES_PER_SET * batch) / batch;
  return Math.floor(baud / 10 / bytesPerSet);
}

function updateBaudHint() {
  const baud = +$('baud').value;
  const max = maxRateForBaud(baud);
  const want = selectedRate();
  let txt = `이 보레이트로 4채널 최대 약 ${max.toLocaleString()} Hz`;
  if (want > max) txt += ` (요청한 ${want.toLocaleString()} Hz 는 대역폭 초과)`;
  $('baudHint').textContent = txt;
  $('baudHint').style.color = want > max ? 'var(--bad)' : '';
}

function updateButtons() {
  const c = state.connected, r = state.running;
  $('btnConnect').textContent = c ? '연결 해제' : '연결';
  $('btnConnect').classList.toggle('primary', !c);
  $('baud').disabled = c;
  $('btnRate').disabled = !c;
  $('btnStart').disabled = !c || r;
  $('btnStop').disabled = !c || !r;
  $('btnPause').disabled = !c;
  $('connDot').className = 'dot' + (r ? ' run' : c ? ' on' : '');
  $('connText').textContent = !c ? '연결 안 됨' : r ? `수집 중 @ ${state.mcuRate} Hz` : '연결됨 (대기)';
}

$('btnConnect').onclick = () => state.connected ? disconnect() : connect();
$('btnRate').onclick = () => { state.requestedRate = selectedRate(); send(T_SET_RATE, u32le(state.requestedRate)); };
$('btnStart').onclick = () => send(T_START);
$('btnStop').onclick = () => send(T_STOP);
$('btnPause').onclick = () => { state.paused = !state.paused; $('btnPause').textContent = state.paused ? '화면 재개' : '화면 일시정지'; state.dirty = true; };
$('btnClear').onclick = () => { store.clear(); state.lastSeq = -1; state.frames = 0; state.dropped = 0; parser.crcErrors = 0; state.dirty = true; };
$('btnLogClear').onclick = () => { $('log').textContent = ''; };
$('rateSel').onchange = () => { $('rateCustom').classList.toggle('hidden', $('rateSel').value !== 'custom'); updateBaudHint(); };
$('rateCustom').oninput = updateBaudHint;
$('baud').onchange = updateBaudHint;
$('winSel').onchange = () => { state.dirty = true; };
$('unitSel').onchange = () => { buildPlot(); };
$('bitsSel').onchange = () => { state.dirty = true; };
$('vfs').oninput = () => { state.dirty = true; };
$('autoY').onchange = () => { buildPlot(); };
$('btnCsv').onclick = exportCsv;

if (!('serial' in navigator)) $('serialWarn').classList.remove('hidden');
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (ev) => {
    if (state.transport instanceof SerialTransport && state.transport.port === ev.target) {
      log('장치가 분리되었습니다');
      state.connected = false; state.running = false; state.transport = null; updateButtons();
    }
  });
}

/* ---------------- 값 변환 ---------------- */
function scaleFactor() {
  if ($('unitSel').value === 'raw') return 1;
  const bits = +$('bitsSel').value;
  return (+$('vfs').value || 3.6) / (1 << bits);
}

/* ---------------- 플롯 ---------------- */
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706'];
let plot = null;

function buildPlot() {
  if (plot) { plot.destroy(); plot = null; }
  const unit = $('unitSel').value === 'raw' ? 'count' : 'V';
  const autoY = $('autoY').checked;
  const opts = {
    width: $('plot').clientWidth - 16,
    height: 400,
    scales: {
      x: { time: false },
      y: autoY ? {} : { range: (u, min, max) => $('unitSel').value === 'raw' ? [0, (1 << +$('bitsSel').value) - 1] : [0, +$('vfs').value || 3.6] },
    },
    axes: [
      { label: 'time (s)', stroke: 'currentColor', grid: { stroke: 'rgba(128,128,128,.2)' }, ticks: { stroke: 'rgba(128,128,128,.3)' } },
      { label: unit, stroke: 'currentColor', grid: { stroke: 'rgba(128,128,128,.2)' }, ticks: { stroke: 'rgba(128,128,128,.3)' }, size: 60 },
    ],
    series: [
      { label: 't' },
      ...COLORS.map((col, i) => ({ label: `CH${i}`, stroke: col, width: 1.2, points: { show: false } })),
    ],
    cursor: { drag: { x: false, y: false } },
    legend: { live: true },
  };
  plot = new uPlot(opts, [[], [], [], [], []], $('plot'));
  state.dirty = true;
}

function buildData() {
  const rate = state.mcuRate || state.requestedRate || 1000;
  const win = +$('winSel').value;
  const n = Math.min(store.count, Math.round(win * rate));
  if (n === 0) return [[], [], [], [], []];
  const maxPts = 4000;
  const stride = Math.max(1, Math.ceil(n / maxPts));
  const m = Math.floor(n / stride);
  const k = scaleFactor();
  const x = new Float64Array(m);
  const ys = Array.from({ length: CH }, () => new Float32Array(m));
  const base = store.total - n;
  for (let j = 0; j < m; j++) {
    const idx = j * stride;
    x[j] = (base + idx) / rate;
    for (let c = 0; c < CH; c++) ys[c][j] = store.at(c, n, idx) * k;
  }
  return [x, ...ys];
}

function exportCsv() {
  const rate = state.mcuRate || state.requestedRate || 1000;
  const n = store.count;
  if (!n) { log('저장할 데이터가 없습니다'); return; }
  const k = scaleFactor();
  const unit = $('unitSel').value === 'raw' ? 'raw' : 'V';
  const base = store.total - n;
  const parts = [`t_s,ch0_${unit},ch1_${unit},ch2_${unit},ch3_${unit}\n`];
  let chunk = [];
  for (let i = 0; i < n; i++) {
    const t = ((base + i) / rate).toFixed(6);
    const row = [t];
    for (let c = 0; c < CH; c++) { const v = store.at(c, n, i) * k; row.push(unit === 'raw' ? v : v.toFixed(5)); }
    chunk.push(row.join(','));
    if (chunk.length >= 5000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
  }
  if (chunk.length) parts.push(chunk.join('\n') + '\n');
  const blob = new Blob(parts, { type: 'text/csv' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = URL.createObjectURL(blob);
  a.download = `adc_${rate}Hz_${stamp}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log(`CSV 저장: ${n.toLocaleString()} 샘플`);
}

/* ---------------- 렌더 루프 ---------------- */
let lastStat = 0;
const EMPTY = new Uint8Array(0);
function frame(now) {
  // 200 ms 동안 새 바이트가 없는데 미완성 프레임이 남아 있으면 첫 바이트를 버리고 재동기
  if (parser.len > 0 && now - parser.lastFeed > 200) parser.feed(EMPTY, true);
  if (plot && state.dirty && !state.paused) {
    plot.setData(buildData());
    state.dirty = false;
  }
  if (now - lastStat > 250) {
    lastStat = now;
    const h = state.rateHist, b = state.byteHist;
    h.push([now, store.total]); b.push([now, state.bytes]);
    while (h.length > 1 && now - h[0][0] > 1000) h.shift();
    while (b.length > 1 && now - b[0][0] > 1000) b.shift();
    const dt = (now - h[0][0]) / 1000;
    const meas = dt > 0.2 ? (store.total - h[0][1]) / dt : 0;
    const bps = dt > 0.2 ? (state.bytes - b[0][1]) / dt : 0;
    $('sMcuRate').textContent = state.mcuRate ? `${state.mcuRate.toLocaleString()} Hz` : '-';
    $('sMeasRate').textContent = state.running ? `${Math.round(meas).toLocaleString()} Hz` : '-';
    $('sBps').textContent = state.connected ? `${(bps / 1000).toFixed(1)} kB/s` : '-';
    $('sFrames').textContent = state.frames.toLocaleString();
    $('sDrop').textContent = state.dropped.toLocaleString();
    $('sDrop').classList.toggle('bad', state.dropped > 0);
    $('sCrc').textContent = parser.crcErrors.toLocaleString();
    $('sCrc').classList.toggle('bad', parser.crcErrors > 0);
    $('sBuf').textContent = `${store.count.toLocaleString()} / ${store.cap.toLocaleString()}`;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => { if (plot) plot.setSize({ width: $('plot').clientWidth - 16, height: 400 }); });

buildPlot();
updateBaudHint();
updateButtons();
requestAnimationFrame(frame);
log('준비됨. 보레이트를 고르고 연결을 누르세요.');
