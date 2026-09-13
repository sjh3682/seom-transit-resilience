/* =============================================================================
   02_services.js — 데이터 로더 · 엔진 클라이언트
   - DataLoader   : base64 → gzip 해제 → 헤더 JSON + 타입 배열. 전부 워커에서 하고
                    결과 버퍼를 transfer 하므로 메인 스레드는 거의 멈추지 않는다.
   - EngineClient : engine/seom_engine.js 를 별도 워커에서 돌린다. 제거 시뮬레이션·정책·
                    경로찾기가 몇백 ms 걸려도 지도 조작이 끊기지 않는다.
   file:// 로 열어도 동작하도록 워커 코드는 Blob URL 로 만든다.
   ============================================================================= */
'use strict';

const LOADER_WORKER_SRC = `
self.onmessage = async (event) => {
  try {
    const b64 = event.data;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    self.postMessage({ progress: '압축 해제 중' });
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const headLen = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
    const base = 4 + headLen;
    const CTORS = { float32: Float32Array, float64: Float64Array, int32: Int32Array, uint32: Uint32Array,
                    int16: Int16Array, uint16: Uint16Array, int8: Int8Array, uint8: Uint8Array };
    const arrays = {}, transfer = [];
    for (const [name, [dtype, offset, length, scale]] of Object.entries(header.arrays)) {
      const view = new CTORS[dtype](buf, base + offset, length);
      let out;
      if (scale) { out = new Float32Array(length); for (let i = 0; i < length; i++) out[i] = view[i] / scale; }
      else out = view.slice();
      arrays[name] = out;
      transfer.push(out.buffer);
    }
    delete header.arrays;
    self.postMessage({ ok: true, header, arrays }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};`;

class DataLoader {
  static load(onProgress) {
    const el = document.getElementById('seomData');
    if (!el) return Promise.reject(new Error('데이터 태그(seomData)가 없습니다.'));
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('이 브라우저는 압축 해제를 지원하지 않습니다. 최신 Chrome·Edge·Safari 에서 열어 주세요.'));
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(URL.createObjectURL(new Blob([LOADER_WORKER_SRC], { type: 'text/javascript' })));
      worker.onmessage = (e) => {
        if (e.data.progress) { onProgress && onProgress(e.data.progress); return; }
        worker.terminate();
        e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message || '데이터 워커 오류'));
      worker.postMessage(el.textContent.trim());
    });
  }
}

class EngineClient {
  /**
   * @param {Dataset} ds
   * 엔진이 필요로 하는 배열만 복사해서 워커에 보낸다(렌더링용 원본은 메인에 남는다).
   */
  constructor(ds, params) {
    const src = document.getElementById('engineSrc').textContent + '\n' + document.getElementById('engineWorkerSrc').textContent;
    this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this.nextId = 1;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    const a = ds.a;
    const arrays = {
      lon: a.g_lon, lat: a.g_lat, pop: a.g_pop, dest: a.g_dest, modes: a.g_modes, nLines: a.g_nlines,
      walkPtr: a.w_ptr, walkIdx: a.w_idx, walkMin: a.w_min,
      patLine: a.p_line, patWait: a.p_wait, patTrips: a.p_trips, patPtr: a.p_ptr, patStops: a.p_stops, patCum: a.p_cum,
      lineMode: a.l_mode,
    };
    this.ready = this.call('init', { arrays, params }).then(() => this.call('warm'));
  }

  call(op, args = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }
}
