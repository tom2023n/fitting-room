/* Fitting Room — client-side custom try-on (no server, no API keys) */
(function () {
  "use strict";

  const MP_CANDIDATES = [
    {
      ver: "0.10.21",
      mod: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs",
      wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
    },
    {
      ver: "0.10.18",
      mod: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs",
      wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
    },
    {
      ver: "0.10.21-unpkg",
      mod: "https://unpkg.com/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs",
      wasm: "https://unpkg.com/@mediapipe/tasks-vision@0.10.21/wasm",
    },
  ];
  const POSE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  const FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const DEFAULT_MODEL = "assets/model-base-tee.jpg";
  const FALLBACK_MODEL = "assets/model-camel-sand.jpg";
  const DB_NAME = "fitting-room-custom";
  const DB_VER = 1;
  const MAX_SIDE = 1600;

  const LM = {
    NOSE: 0,
    L_EYE: 2,
    R_EYE: 5,
    L_EAR: 7,
    R_EAR: 8,
    L_SHOULDER: 11,
    R_SHOULDER: 12,
    L_HIP: 23,
    R_HIP: 24,
    L_KNEE: 25,
    R_KNEE: 26,
    L_ANKLE: 27,
    R_ANKLE: 28,
  };

  const CURATED = [
    { id: "curated-crimson", name: "朱红拉链帽衫", kind: "jacket", src: "assets/jacket-crimson.jpg" },
    { id: "curated-camel", name: "驼色灯芯绒羽绒服", kind: "jacket", src: "assets/jacket-camel.jpg" },
    { id: "curated-colorblock", name: "岩灰拼色防风衣", kind: "jacket", src: "assets/jacket-colorblock.jpg" },
    { id: "curated-mist", name: "雾蓝连帽羽绒服", kind: "jacket", src: "assets/jacket-mist.jpg" },
    { id: "curated-black", name: "墨黑工装裤", kind: "pants", src: "assets/pants-black.jpg" },
    { id: "curated-olive", name: "橄榄侧条工装裤", kind: "pants", src: "assets/pants-olive.jpg" },
    { id: "curated-sand", name: "沙色摇粒绒束脚裤", kind: "pants", src: "assets/pants-sand.jpg" },
    { id: "curated-khaki", name: "亚麻阔腿裤", kind: "pants", src: "assets/pants-khaki.jpg" },
  ];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const toast = (m) => (window.FR && window.FR.toast ? window.FR.toast(m) : console.log(m));

  const state = {
    opened: false,
    engineReady: false,
    engineError: null,
    poseLandmarker: null,
    faceDetector: null,
    model: null,          // { img, w, h, canvas }
    landmarks: null,      // normalized landmarks array
    wardrobe: [],         // { id, name, kind, canvas, thumb }
    worn: { jacket: null, pants: null },
    selected: null,       // "jacket" | "pants"
    uploadKind: "jacket",
    showPose: false,
    dragging: null,
    viewMode: "overlay", // "overlay" | "ai"
    aiResult: null,      // { canvas, w, h, meta }
  };

  let db = null;
  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  /* ——— math ——— */
  function vis(lm, t = 0.4) {
    return !!(lm && (lm.visibility === undefined || lm.visibility >= t));
  }
  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  function ang(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
  function px(lm, w, h) {
    return { x: lm.x * w, y: lm.y * h, v: lm.visibility };
  }

  /* ——— images ——— */
  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("无法加载图片"));
      img.src = src;
    });
  }

  async function fileToImage(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() =>
      createImageBitmap(file)
    );
    let w = bmp.width;
    let h = bmp.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return c;
  }

  function cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  function canvasToBlob(canvas, type = "image/png", quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /* ——— IndexedDB ——— */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("wardrobe")) {
          d.createObjectStore("wardrobe", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("wardrobe", "readonly");
      const r = tx.objectStore("wardrobe").getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  function dbPut(item) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("wardrobe", "readwrite");
      tx.objectStore("wardrobe").put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbDel(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("wardrobe", "readwrite");
      tx.objectStore("wardrobe").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function blobToCanvas(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return c;
  }

  /* ——— background removal ——— */
  function alphaBBox(canvas, t = 8) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > t) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
          count++;
        }
      }
    }
    if (count === 0) return { x: 0, y: 0, w, h, count: 0 };
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count };
  }

  function cropToBBox(canvas, pad = 4) {
    const b = alphaBBox(canvas);
    if (!b.count) return canvas;
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    const w = Math.min(canvas.width - x, b.w + pad * 2);
    const h = Math.min(canvas.height - y, b.h + pad * 2);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return out;
  }

  function featherAlpha(canvas, radius = 3) {
    if (radius <= 0) return canvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h);
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = img.data[i * 4 + 3];
    const tmp = new Float32Array(w * h);
    const r = radius;
    // separable box blur on alpha, but only shrink (min with original) to feather edges out
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      const denom = r * 2 + 1;
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / denom;
        acc -= a[row + Math.min(w - 1, Math.max(0, x - r))];
        acc += a[row + Math.min(w - 1, Math.max(0, x + r + 1))];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      const denom = r * 2 + 1;
      for (let y = 0; y < h; y++) {
        const v = acc / denom;
        const i = (y * w + x) * 4 + 3;
        img.data[i] = Math.min(img.data[i], Math.max(0, Math.round(v)));
        acc -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
        acc += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function floodCutout(source) {
    const w = source.width;
    const h = source.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    // median-ish background from corners + edge midpoints
    const samples = [];
    const pick = (x, y) => {
      const i = (y * w + x) * 4;
      samples.push([d[i], d[i + 1], d[i + 2]]);
    };
    for (const [x, y] of [
      [2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3],
      [Math.floor(w / 2), 2], [Math.floor(w / 2), h - 3],
      [2, Math.floor(h / 2)], [w - 3, Math.floor(h / 2)],
    ]) pick(x, y);
    samples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    const bg = samples[Math.floor(samples.length / 2)];

    // uniformity of edges
    let edgeVar = 0;
    samples.forEach((s) => {
      edgeVar += Math.abs(s[0] - bg[0]) + Math.abs(s[1] - bg[1]) + Math.abs(s[2] - bg[2]);
    });
    edgeVar /= samples.length;

    const tol = Math.max(28, Math.min(48, edgeVar + 28));
    const close = (i) =>
      Math.abs(d[i] - bg[0]) <= tol &&
      Math.abs(d[i + 1] - bg[1]) <= tol &&
      Math.abs(d[i + 2] - bg[2]) <= tol;

    const seen = new Uint8Array(w * h);
    const qx = new Int32Array(w * h);
    const qy = new Int32Array(w * h);
    let qs = 0, qe = 0;
    const push = (x, y) => {
      const k = y * w + x;
      if (seen[k]) return;
      const i = k * 4;
      if (!close(i)) return;
      seen[k] = 1;
      qx[qe] = x;
      qy[qe] = y;
      qe++;
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }
    while (qs < qe) {
      const x = qx[qs];
      const y = qy[qs];
      qs++;
      if (x > 0) push(x - 1, y);
      if (x + 1 < w) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y + 1 < h) push(x, y + 1);
    }

    const bgCount = qe;
    // transparency + soft edge by color distance for leftover near-bg pixels
    for (let k = 0; k < w * h; k++) {
      const i = k * 4;
      if (seen[k]) {
        d[i + 3] = 0;
        continue;
      }
      const dr = Math.abs(d[i] - bg[0]);
      const dg = Math.abs(d[i + 1] - bg[1]);
      const dbv = Math.abs(d[i + 2] - bg[2]);
      const md = Math.max(dr, dg, dbv);
      if (md < tol * 0.55) {
        d[i + 3] = Math.round((d[i + 3] * md) / (tol * 0.55));
      }
    }
    ctx.putImageData(img, 0, 0);
    featherAlpha(canvas, 2);
    const cropped = cropToBBox(canvas, 6);
    const conf = bgCount / (w * h);
    return { canvas: cropped, confidence: conf, edgeVar };
  }

  async function tryImgly(source) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12000);
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.8/+esm");
      const fn = mod.removeBackground || mod.default;
      if (!fn) throw new Error("no removeBackground");
      const blob = await fn(source, {
        publicPath: "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.8/dist/",
        model: "small",
        device: "cpu",
        output: { format: "image/png", quality: 0.9 },
      });
      const c = await blobToCanvas(blob);
      return cropToBBox(c, 4);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cutout(source, { preferFlood = false } = {}) {
    const flood = floodCutout(source);
    // studio / white-bg product shots: flood is excellent and instant
    if (preferFlood || flood.confidence > 0.28 && flood.edgeVar < 40) {
      return flood.canvas;
    }
    try {
      const fancy = await tryImgly(source);
      const b = alphaBBox(fancy);
      if (b.count > 80) return fancy;
    } catch (err) {
      console.warn("imgly failed, using flood fill", err);
    }
    return flood.canvas;
  }

  /* ——— MediaPipe ——— */
  async function loadEngine() {
    if (state.engineReady) return;
    setStatus("正在加载试穿引擎…");
    try {
      let mod = null;
      let wasmUrl = null;
      let lastErr = null;
      for (const cand of MP_CANDIDATES) {
        try {
          mod = await import(cand.mod);
          wasmUrl = cand.wasm;
          console.info("MediaPipe loaded", cand.ver);
          break;
        } catch (e) {
          lastErr = e;
          console.warn("MediaPipe candidate failed", cand.ver, e);
        }
      }
      if (!mod) throw lastErr || new Error("no MediaPipe module");

      // Fresh FilesetResolver per attempt so a failed GPU graph cannot poison WASM.
      const freshVision = () => mod.FilesetResolver.forVisionTasks(wasmUrl);

      const makePose = async (delegate) => {
        const vision = await freshVision();
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        return mod.PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate },
          runningMode: "IMAGE",
          numPoses: 1,
          canvas,
        });
      };

      // CPU first: reliable under software WebGL / headless, and fast enough for stills.
      let used = null;
      try {
        state.poseLandmarker = await makePose("CPU");
        used = "CPU";
      } catch (e) {
        console.warn("CPU pose failed, trying GPU", e);
        state.poseLandmarker = await makePose("GPU");
        used = "GPU";
      }
      console.info("Pose landmarker ready", used);
      state.mpDelegate = used;

      try {
        const vision = await freshVision();
        const fc = document.createElement("canvas");
        fc.width = 256;
        fc.height = 256;
        state.faceDetector = await mod.FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
          runningMode: "IMAGE",
          canvas: fc,
        });
      } catch (e) {
        console.warn("face detector unavailable", e);
      }
      state.engineReady = true;
      state.engineError = null;
    } catch (err) {
      console.error(err);
      state.engineError = err;
      state.engineReady = false;
      toast("姿态引擎加载失败，将使用大致比例，请手动微调");
    } finally {
      setStatus("");
    }
  }

  function detectPose(image) {
    state.landmarks = null;
    if (!state.poseLandmarker) return null;
    try {
      const res = state.poseLandmarker.detect(image);
      const lms = res && res.landmarks && res.landmarks[0];
      if (lms && lms.length) {
        state.landmarks = lms;
        return lms;
      }
    } catch (e) {
      console.warn("pose detect", e);
    }
    return null;
  }

  function detectFaceBox(image) {
    if (!state.faceDetector) return null;
    try {
      const res = state.faceDetector.detect(image);
      const det = res && res.detections && res.detections[0];
      if (!det) return null;
      const bb = det.boundingBox;
      const kps = (det.keypoints || []).map((k) => ({ x: k.x, y: k.y }));
      return {
        x: bb.originX,
        y: bb.originY,
        w: bb.width,
        h: bb.height,
        keypoints: kps,
      };
    } catch (e) {
      console.warn("face detect", e);
      return null;
    }
  }

  function faceFromPose(lms, w, h) {
    if (!lms) return null;
    const nose = vis(lms[LM.NOSE]) ? px(lms[LM.NOSE], w, h) : null;
    const le = vis(lms[LM.L_EYE], 0.2) ? px(lms[LM.L_EYE], w, h) : null;
    const re = vis(lms[LM.R_EYE], 0.2) ? px(lms[LM.R_EYE], w, h) : null;
    if (!nose && !le && !re) return null;
    const midEye = le && re ? mid(le, re) : nose;
    const eyeDist = le && re ? dist(le, re) : w * 0.06;
    const width = eyeDist * 2.6;
    const height = eyeDist * 3.4;
    const cx = midEye.x;
    const cy = midEye.y + eyeDist * 0.35;
    const rotation = le && re ? ang(re, le) : 0; // image: right eye to left eye
    return { cx, cy, width, height, rotation, eyeDist, le, re, nose };
  }

  /* ——— face composite ——— */
  function statsRegion(ctx, cx, cy, rw, rh) {
    const x0 = Math.max(0, Math.round(cx - rw));
    const y0 = Math.max(0, Math.round(cy - rh));
    const x1 = Math.min(ctx.canvas.width, Math.round(cx + rw));
    const y1 = Math.min(ctx.canvas.height, Math.round(cy + rh));
    const img = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    const d = img.data;
    let n = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 16) continue;
      // rough skin: not too blue, not too dark
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      if (mx < 40) continue;
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    if (!n) return { r: 180, g: 140, b: 120 };
    return { r: r / n, g: g / n, b: b / n };
  }

  async function compositeFace(faceSource, modelCanvas) {
    const src = faceSource instanceof HTMLCanvasElement ? faceSource : await (async () => {
      const c = document.createElement("canvas");
      c.width = faceSource.width;
      c.height = faceSource.height;
      c.getContext("2d").drawImage(faceSource, 0, 0);
      return c;
    })();
    const out = cloneCanvas(modelCanvas);
    const mw = out.width;
    const mh = out.height;

    // destination face from pose (reliable on full-body) or face detector
    let dest = state.landmarks ? faceFromPose(state.landmarks, mw, mh) : null;
    if (!dest) {
      const box = detectFaceBox(out);
      if (box) {
        dest = {
          cx: box.x + box.w / 2,
          cy: box.y + box.h / 2,
          width: box.w * 1.05,
          height: box.h * 1.2,
          rotation: 0,
        };
      }
    }
    if (!dest) throw new Error("没能在模特照片上找到面部");

    // source face
    let srcFace = detectFaceBox(src);
    if (!srcFace) {
      // try pose on the headshot
      const lms = state.poseLandmarker ? (state.poseLandmarker.detect(src).landmarks || [])[0] : null;
      const fromPose = lms ? faceFromPose(lms, src.width, src.height) : null;
      if (fromPose) {
        srcFace = {
          x: fromPose.cx - fromPose.width / 2,
          y: fromPose.cy - fromPose.height / 2,
          w: fromPose.width,
          h: fromPose.height,
          keypoints: [],
          rotation: fromPose.rotation,
        };
      } else {
        // treat most of the image as a face
        const m = Math.min(src.width, src.height);
        srcFace = {
          x: (src.width - m * 0.72) / 2,
          y: (src.height - m * 0.86) / 2,
          w: m * 0.72,
          h: m * 0.86,
          keypoints: [],
          rotation: 0,
        };
      }
    }

    // extract source face onto a temp canvas, slightly expanded
    const pad = 0.18;
    const sx = Math.max(0, srcFace.x - srcFace.w * pad);
    const sy = Math.max(0, srcFace.y - srcFace.h * pad);
    const sw = Math.min(src.width - sx, srcFace.w * (1 + pad * 2));
    const sh = Math.min(src.height - sy, srcFace.h * (1 + pad * 2));
    const faceC = document.createElement("canvas");
    const scaleUp = Math.max(2, Math.round(Math.max(dest.width, dest.height) / Math.max(sw, 1) * 2));
    faceC.width = Math.round(sw * Math.min(scaleUp, 4));
    faceC.height = Math.round(sh * Math.min(scaleUp, 4));
    const fctx = faceC.getContext("2d");
    fctx.drawImage(src, sx, sy, sw, sh, 0, 0, faceC.width, faceC.height);

    // color match
    const sMean = statsRegion(fctx, faceC.width / 2, faceC.height * 0.52, faceC.width * 0.22, faceC.height * 0.22);
    const dctx = out.getContext("2d", { willReadFrequently: true });
    const dMean = statsRegion(dctx, dest.cx, dest.cy, dest.width * 0.22, dest.height * 0.22);
    const img = fctx.getImageData(0, 0, faceC.width, faceC.height);
    const dd = img.data;
    const kr = dMean.r / Math.max(8, sMean.r);
    const kg = dMean.g / Math.max(8, sMean.g);
    const kb = dMean.b / Math.max(8, sMean.b);
    const clamp = (v) => (v < 0.72 ? 0.72 : v > 1.35 ? 1.35 : v);
    const cr = clamp(kr), cg = clamp(kg), cb = clamp(kb);
    for (let i = 0; i < dd.length; i += 4) {
      dd[i] = Math.max(0, Math.min(255, dd[i] * cr));
      dd[i + 1] = Math.max(0, Math.min(255, dd[i + 1] * cg));
      dd[i + 2] = Math.max(0, Math.min(255, dd[i + 2] * cb));
    }
    fctx.putImageData(img, 0, 0);

    // feathered ellipse mask
    const mask = document.createElement("canvas");
    mask.width = faceC.width;
    mask.height = faceC.height;
    const mctx = mask.getContext("2d");
    const mx = mask.width / 2;
    const my = mask.height * 0.52;
    const rx = mask.width * 0.36;
    const ry = mask.height * 0.42;
    const g = mctx.createRadialGradient(mx, my, rx * 0.62, mx, my, rx);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(0.72, "rgba(0,0,0,0.92)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    mctx.fillStyle = g;
    mctx.save();
    mctx.translate(mx, my);
    mctx.scale(1, ry / rx);
    mctx.beginPath();
    mctx.arc(0, 0, rx, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
    mctx.globalCompositeOperation = "source-in";
    mctx.drawImage(faceC, 0, 0);

    // draw onto model, aligned
    dctx.save();
    dctx.translate(dest.cx, dest.cy);
    dctx.rotate(dest.rotation || 0);
    const dw = dest.width * 1.12;
    const dh = dest.height * 1.12;
    dctx.drawImage(mask, -dw / 2, -dh / 2, dw, dh);
    dctx.restore();
    return out;
  }

  /* ——— auto fit ——— */
  function pair(lms, ia, ib, w, h, t = 0.35) {
    const a = vis(lms[ia], t) ? px(lms[ia], w, h) : null;
    const b = vis(lms[ib], t) ? px(lms[ib], w, h) : null;
    if (a && b) {
      // Angle must go from image-left to image-right. Landmark "left"
      // is the person's left, which sits on the right of a front-facing photo —
      // using a→b raw would rotate the garment ~180°.
      const left = a.x <= b.x ? a : b;
      const right = a.x <= b.x ? b : a;
      return { a, b, mid: mid(a, b), width: dist(a, b), angle: ang(left, right) };
    }
    return null;
  }

  function estimateFallback(w, h) {
    // generic standing figure in a studio frame
    const cx = w / 2;
    return {
      shoulders: { mid: { x: cx, y: h * 0.28 }, width: w * 0.22, angle: 0 },
      hips: { mid: { x: cx, y: h * 0.52 }, width: w * 0.18, angle: 0 },
      ankles: { mid: { x: cx, y: h * 0.88 }, width: w * 0.12, angle: 0 },
      knees: { mid: { x: cx, y: h * 0.70 }, width: w * 0.15, angle: 0 },
      fallback: true,
    };
  }

  function bodyMetrics(lms, w, h) {
    if (!lms) return estimateFallback(w, h);
    const sh = pair(lms, LM.L_SHOULDER, LM.R_SHOULDER, w, h, 0.25);
    const hp = pair(lms, LM.L_HIP, LM.R_HIP, w, h, 0.2);
    const kn = pair(lms, LM.L_KNEE, LM.R_KNEE, w, h, 0.2);
    const an = pair(lms, LM.L_ANKLE, LM.R_ANKLE, w, h, 0.15);
    if (!sh) return estimateFallback(w, h);
    const hips = hp || {
      mid: { x: sh.mid.x, y: sh.mid.y + (kn ? (kn.mid.y - sh.mid.y) * 0.45 : h * 0.24) },
      width: sh.width * 0.85,
      angle: sh.angle,
    };
    const knees = kn || {
      mid: { x: hips.mid.x, y: hips.mid.y + (an ? (an.mid.y - hips.mid.y) * 0.5 : h * 0.18) },
      width: hips.width * 0.8,
      angle: hips.angle,
    };
    const ankles = an || {
      mid: { x: knees.mid.x, y: Math.min(h * 0.95, knees.mid.y + (knees.mid.y - hips.mid.y)) },
      width: hips.width * 0.65,
      angle: hips.angle,
    };
    return { shoulders: sh, hips, knees, ankles, fallback: false };
  }

  function autoFit(kind, garmentCanvas, metrics, w, h) {
    const bbox = alphaBBox(garmentCanvas);
    const gw = Math.max(8, bbox.w);
    const gh = Math.max(8, bbox.h);
    const user = { dx: 0, dy: 0, scale: 1, sx: 1, sy: 1, rot: 0, opacity: 1 };

    if (kind === "jacket") {
      const sh = metrics.shoulders;
      const hp = metrics.hips;
      const torso = Math.max(24, dist(sh.mid, hp.mid));
      const width = sh.width * 2.25;
      const height = torso * 1.38;
      return {
        cx: sh.mid.x,
        cy: sh.mid.y + torso * 0.38,
        width,
        height,
        rotation: sh.angle,
        aspect: gw / gh,
        user,
      };
    }
    const hp = metrics.hips;
    const an = metrics.ankles;
    const shW = metrics.shoulders ? metrics.shoulders.width : hp.width * 1.2;
    const len = Math.max(32, dist(hp.mid, an.mid));
    // Hip landmarks sit at joint centers, well inside the silhouette;
    // baggy / cargo pants need a generous width, at least shoulder-like.
    const width = Math.max(hp.width * 2.7, shW * 1.48);
    const height = len * 1.14;
    const top = hp.mid.y - len * 0.10;
    return {
      cx: (hp.mid.x + an.mid.x) / 2,
      cy: top + height / 2,
      width,
      height,
      rotation: (hp.angle + an.angle) / 2,
      aspect: gw / gh,
      user,
    };
  }

  /* ——— render ——— */
  function wornDrawParams(layer) {
    const u = layer.user;
    const scale = u.scale;
    const w = layer.width * scale * u.sx;
    const h = layer.height * scale * u.sy;
    return {
      cx: layer.cx + u.dx,
      cy: layer.cy + u.dy,
      w,
      h,
      rot: layer.rotation + (u.rot * Math.PI) / 180,
      opacity: u.opacity,
    };
  }

  function hitGarment(kind, x, y) {
    const layer = state.worn[kind];
    if (!layer) return false;
    const p = wornDrawParams(layer);
    const dx = x - p.cx;
    const dy = y - p.cy;
    const c = Math.cos(-p.rot);
    const s = Math.sin(-p.rot);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2;
  }

  function drawGarment(ctx, layer, { handles = false, selected = false } = {}) {
    const p = wornDrawParams(layer);
    ctx.save();
    ctx.translate(p.cx, p.cy);
    ctx.rotate(p.rot);
    ctx.globalAlpha = p.opacity;
    ctx.drawImage(layer.canvas, -p.w / 2, -p.h / 2, p.w, p.h);
    ctx.globalAlpha = 1;
    if (handles && selected) {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = Math.max(1, layer.canvas.width * 0.002);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.setLineDash([]);
      const hs = Math.max(6, Math.min(p.w, p.h) * 0.04);
      const corners = [
        [-p.w / 2, -p.h / 2],
        [p.w / 2, -p.h / 2],
        [p.w / 2, p.h / 2],
        [-p.w / 2, p.h / 2],
      ];
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1.5;
      corners.forEach(([hx, hy]) => {
        ctx.beginPath();
        ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.fill();
        ctx.stroke();
      });
      // rotation handle
      ctx.beginPath();
      ctx.moveTo(0, -p.h / 2);
      ctx.lineTo(0, -p.h / 2 - hs * 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -p.h / 2 - hs * 3, hs * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPose(ctx, lms, w, h) {
    if (!lms) return;
    ctx.save();
    ctx.fillStyle = "rgba(17,17,17,0.75)";
    ctx.strokeStyle = "rgba(17,17,17,0.45)";
    ctx.lineWidth = Math.max(1.5, w * 0.002);
    const pairs = [
      [LM.L_SHOULDER, LM.R_SHOULDER],
      [LM.L_SHOULDER, LM.L_HIP],
      [LM.R_SHOULDER, LM.R_HIP],
      [LM.L_HIP, LM.R_HIP],
      [LM.L_HIP, LM.L_KNEE],
      [LM.R_HIP, LM.R_KNEE],
      [LM.L_KNEE, LM.L_ANKLE],
      [LM.R_KNEE, LM.R_ANKLE],
    ];
    const P = (i) => px(lms[i], w, h);
    pairs.forEach(([a, b]) => {
      if (!vis(lms[a], 0.2) || !vis(lms[b], 0.2)) return;
      const A = P(a), B = P(b);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    });
    [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.NOSE].forEach(
      (i) => {
        if (!vis(lms[i], 0.2)) return;
        const p = P(i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(3, w * 0.006), 0, Math.PI * 2);
        ctx.fill();
      }
    );
    ctx.restore();
  }

  function activeView() {
    if (state.viewMode === "ai" && state.aiResult) return state.aiResult;
    return state.model;
  }

  function render(opts = {}) {
    const canvas = opts.canvas || $("#tryon-canvas");
    const src = activeView();
    if (!canvas || !src) return;
    const mw = src.w;
    const mh = src.h;
    const handles = opts.handles !== false && state.viewMode !== "ai";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / mw;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (state.viewMode === "ai" && state.aiResult) {
      ctx.drawImage(state.aiResult.canvas, 0, 0, mw, mh);
      return;
    }
    ctx.drawImage(state.model.canvas || state.model.img, 0, 0, mw, mh);
    if (state.worn.pants) drawGarment(ctx, state.worn.pants, { handles, selected: state.selected === "pants" });
    if (state.worn.jacket) drawGarment(ctx, state.worn.jacket, { handles, selected: state.selected === "jacket" });
    if (handles && state.showPose && state.landmarks) drawPose(ctx, state.landmarks, mw, mh);
  }

  function layoutCanvas() {
    const canvas = $("#tryon-canvas");
    const frame = $("#canvas-frame");
    const src = activeView();
    if (!canvas || !frame || !src) return;
    const r = frame.getBoundingClientRect();
    const pad = 4;
    const availW = Math.max(80, r.width - pad);
    const availH = Math.max(80, r.height - pad);
    const fit = Math.min(availW / src.w, availH / src.h);
    const cssW = src.w * fit;
    const cssH = src.h * fit;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    render();
  }

  function eventToImage(e) {
    const canvas = $("#tryon-canvas");
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * state.model.w,
      y: ((e.clientY - r.top) / r.height) * state.model.h,
    };
  }

  /* ——— wear / wardrobe ——— */
  function metricsNow() {
    return bodyMetrics(state.landmarks, state.model.w, state.model.h);
  }

  function wear(item, { reset = true } = {}) {
    if (!state.model) return;
    const m = metricsNow();
    const base = autoFit(item.kind, item.canvas, m, state.model.w, state.model.h);
    const prev = state.worn[item.kind];
    if (!reset && prev && prev.id === item.id) {
      base.user = { ...prev.user };
    }
    state.worn[item.kind] = {
      ...base,
      id: item.id,
      name: item.name,
      kind: item.kind,
      canvas: item.canvas,
    };
    state.selected = item.kind;
    syncAdjust();
    renderWardrobe();
    render();
  }

  function takeOff(kind) {
    state.worn[kind] = null;
    if (state.selected === kind) {
      state.selected = state.worn.jacket ? "jacket" : state.worn.pants ? "pants" : null;
    }
    syncAdjust();
    renderWardrobe();
    render();
  }

  function uid() {
    return "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }

  async function addToWardrobe({ id, name, kind, canvas, persist = true }) {
    const existing = state.wardrobe.find((x) => x.id === id);
    if (existing) {
      existing.canvas = canvas;
      existing.name = name;
      existing.kind = kind;
    } else {
      state.wardrobe.push({ id, name, kind, canvas });
    }
    if (persist && db) {
      const blob = await canvasToBlob(canvas, "image/png");
      await dbPut({ id, name, kind, blob, createdAt: Date.now() });
    }
    renderWardrobe();
    return state.wardrobe.find((x) => x.id === id);
  }

  function renderWardrobe() {
    const el = $("#wardrobe");
    if (!el) return;
    if (!state.wardrobe.length) {
      el.innerHTML = `<p class="wardrobe-empty">衣橱是空的。上传衣服，或导入精选单品试试。</p>`;
      return;
    }
    el.innerHTML = state.wardrobe
      .map((item) => {
        const worn = state.worn[item.kind] && state.worn[item.kind].id === item.id;
        const src = item.canvas.toDataURL("image/png");
        return `<article class="ward-item${worn ? " is-worn" : ""}" data-id="${item.id}" data-kind="${item.kind}">
          <button type="button" class="ward-del" data-del="${item.id}" aria-label="从衣橱移除">×</button>
          <img alt="${item.name}" src="${src}">
          <div class="ward-meta"><span>${item.kind === "jacket" ? "外套" : "裤装"}</span></div>
        </article>`;
      })
      .join("");
  }

  /* ——— sliders ——— */
  function syncAdjust() {
    const panel = $("#adjust-panel");
    const kind = state.selected;
    const layer = kind && state.worn[kind];
    if (!layer) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $("#adjust-name").textContent = layer.name || (kind === "jacket" ? "外套" : "裤装");
    const u = layer.user;
    const set = (id, v, label) => {
      const i = $("#" + id);
      const l = $("#" + id + "-val");
      i.value = v;
      l.textContent = label;
    };
    set("adj-x", Math.round(u.dx), Math.round(u.dx));
    set("adj-y", Math.round(u.dy), Math.round(u.dy));
    set("adj-scale", Math.round(u.scale * 100), Math.round(u.scale * 100) + "%");
    set("adj-sx", Math.round(u.sx * 100), Math.round(u.sx * 100) + "%");
    set("adj-sy", Math.round(u.sy * 100), Math.round(u.sy * 100) + "%");
    set("adj-rot", u.rot.toFixed(1), u.rot.toFixed(1) + "°");
    set("adj-op", Math.round(u.opacity * 100), Math.round(u.opacity * 100) + "%");
  }

  function bindSliders() {
    const read = () => {
      const layer = state.selected && state.worn[state.selected];
      if (!layer) return;
      layer.user.dx = +$("#adj-x").value;
      layer.user.dy = +$("#adj-y").value;
      layer.user.scale = +$("#adj-scale").value / 100;
      layer.user.sx = +$("#adj-sx").value / 100;
      layer.user.sy = +$("#adj-sy").value / 100;
      layer.user.rot = +$("#adj-rot").value;
      layer.user.opacity = +$("#adj-op").value / 100;
      syncAdjust();
      render();
    };
    ["adj-x", "adj-y", "adj-scale", "adj-sx", "adj-sy", "adj-rot", "adj-op"].forEach((id) => {
      $("#" + id).addEventListener("input", read);
    });
    $("#reset-fit").addEventListener("click", () => {
      const kind = state.selected;
      const layer = kind && state.worn[kind];
      if (!layer) return;
      const item = state.wardrobe.find((x) => x.id === layer.id) || layer;
      wear({ id: layer.id, name: layer.name, kind, canvas: item.canvas || layer.canvas }, { reset: true });
    });
    $("#take-off").addEventListener("click", () => {
      if (state.selected) takeOff(state.selected);
    });
  }

  /* ——— canvas interaction ——— */
  function handleAt(layer, x, y) {
    const p = wornDrawParams(layer);
    const dx = x - p.cx;
    const dy = y - p.cy;
    const c = Math.cos(-p.rot);
    const s = Math.sin(-p.rot);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const hs = Math.max(10, Math.min(p.w, p.h) * 0.08);
    const corners = {
      nw: [-p.w / 2, -p.h / 2],
      ne: [p.w / 2, -p.h / 2],
      se: [p.w / 2, p.h / 2],
      sw: [-p.w / 2, p.h / 2],
    };
    for (const [name, [hx, hy]] of Object.entries(corners)) {
      if (Math.abs(lx - hx) <= hs && Math.abs(ly - hy) <= hs) return { type: "scale", corner: name };
    }
    if (Math.hypot(lx - 0, ly - (-p.h / 2 - hs * 2.4)) <= hs * 1.4) return { type: "rotate" };
    if (Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2) return { type: "move" };
    return null;
  }

  function bindCanvas() {
    const canvas = $("#tryon-canvas");
    let drag = null;

    canvas.addEventListener("pointerdown", (e) => {
      if (!state.model || state.viewMode === "ai") return;
      const pt = eventToImage(e);
      const order = ["jacket", "pants"]; // top first for hit
      let hit = null;
      for (const kind of order) {
        const layer = state.worn[kind];
        if (!layer) continue;
        const h = handleAt(layer, pt.x, pt.y);
        if (h) {
          hit = { kind, ...h };
          break;
        }
      }
      if (!hit) {
        state.selected = null;
        syncAdjust();
        render();
        return;
      }
      state.selected = hit.kind;
      const layer = state.worn[hit.kind];
      drag = {
        ...hit,
        start: pt,
        orig: { ...layer.user },
        origFit: { cx: layer.cx, cy: layer.cy, width: layer.width, height: layer.height, rotation: layer.rotation },
        startDist: Math.hypot(pt.x - (layer.cx + layer.user.dx), pt.y - (layer.cy + layer.user.dy)),
        startAngle: Math.atan2(pt.y - (layer.cy + layer.user.dy), pt.x - (layer.cx + layer.user.dx)),
      };
      canvas.setPointerCapture(e.pointerId);
      syncAdjust();
      render();
      e.preventDefault();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drag) {
        // cursor
        if (!state.model) return;
        const pt = eventToImage(e);
        const kind = state.selected;
        const layer = kind && state.worn[kind];
        let cur = "default";
        if (layer) {
          const h = handleAt(layer, pt.x, pt.y);
          if (h && h.type === "move") cur = "grab";
          if (h && h.type === "scale") cur = "nwse-resize";
          if (h && h.type === "rotate") cur = "crosshair";
        }
        canvas.style.cursor = cur;
        return;
      }
      const layer = state.worn[drag.kind];
      const pt = eventToImage(e);
      if (drag.type === "move") {
        layer.user.dx = drag.orig.dx + (pt.x - drag.start.x);
        layer.user.dy = drag.orig.dy + (pt.y - drag.start.y);
      } else if (drag.type === "scale") {
        const cx = layer.cx + layer.user.dx;
        const cy = layer.cy + layer.user.dy;
        const d0 = drag.startDist || 1;
        const d1 = Math.hypot(pt.x - cx, pt.y - cy);
        layer.user.scale = Math.max(0.4, Math.min(2.2, drag.orig.scale * (d1 / d0)));
      } else if (drag.type === "rotate") {
        const cx = layer.cx + layer.user.dx;
        const cy = layer.cy + layer.user.dy;
        const a1 = Math.atan2(pt.y - cy, pt.x - cx);
        const deg = ((a1 - drag.startAngle) * 180) / Math.PI;
        layer.user.rot = Math.max(-45, Math.min(45, drag.orig.rot + deg));
      }
      syncAdjust();
      render();
    });

    const end = () => {
      drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /* ——— model load ——— */
  function setStatus(msg) {
    const el = $("#canvas-status");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  function setPoseStatus(ok, fallback) {
    const el = $("#pose-status");
    if (!el) return;
    if (ok && !fallback) el.textContent = "已识别人体姿态，可自动贴合衣服";
    else if (ok && fallback) el.textContent = "未完整识别姿态，已用大致比例，请手动调整";
    else el.textContent = "尚未识别姿态";
  }

  async function setModelFromSource(source, { runPose = true, label = "模特" } = {}) {
    let canvas;
    if (source instanceof HTMLCanvasElement) {
      canvas = source;
    } else if (typeof source === "string") {
      const img = await loadImg(source);
      canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext("2d").drawImage(source, 0, 0);
    }
    // cap size
    const s = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
    if (s < 1) {
      const c = document.createElement("canvas");
      c.width = Math.round(canvas.width * s);
      c.height = Math.round(canvas.height * s);
      c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
      canvas = c;
    }
    state.model = { canvas, w: canvas.width, h: canvas.height, label };
    if (runPose) {
      setStatus("正在识别姿态…");
      await new Promise((r) => requestAnimationFrame(r));
      const lms = detectPose(canvas);
      const m = bodyMetrics(lms, canvas.width, canvas.height);
      setPoseStatus(!!lms, m.fallback);
      setStatus("");
    }
    // re-fit currently worn garments
    ["jacket", "pants"].forEach((kind) => {
      const layer = state.worn[kind];
      if (!layer) return;
      const item = { id: layer.id, name: layer.name, kind, canvas: layer.canvas };
      wear(item, { reset: true });
    });
    layoutCanvas();
  }

  /* ——— uploads ——— */
  async function onModelUpload(file) {
    try {
      setStatus("正在读取照片…");
      const c = await fileToImage(file);
      await setModelFromSource(c, { label: "我的照片" });
      toast("已使用你的照片作为模特");
    } catch (e) {
      console.error(e);
      toast("照片读取失败");
      setStatus("");
    }
  }

  async function onFaceUpload(file) {
    if (!state.model) {
      toast("请先选择或上传模特照片");
      return;
    }
    try {
      setStatus("正在贴合头像…");
      const face = await fileToImage(file);
      // detect pose first if needed
      if (!state.landmarks) detectPose(state.model.canvas);
      const out = await compositeFace(face, state.model.canvas);
      await setModelFromSource(out, { label: "换脸模特" });
      toast("已把头像贴到模特上，可再微调衣服");
    } catch (e) {
      console.error(e);
      toast(e.message || "换脸失败，请换一张正脸照片试试");
      setStatus("");
    }
  }

  async function onGarmentUpload(file) {
    try {
      setStatus("正在去除背景…");
      const raw = await fileToImage(file);
      const cut = await cutout(raw);
      const kind = state.uploadKind;
      const rawName = (file.name || "").replace(/\.[^.]+$/, "");
      const name = /^(jacket|pants|img|image|dsc|img_)/i.test(rawName) || !rawName
        ? (kind === "jacket" ? "上传的外套" : "上传的裤子")
        : rawName;
      const item = await addToWardrobe({
        id: uid(),
        name,
        kind,
        canvas: cut,
      });
      wear(item, { reset: true });
      setStatus("");
      toast("已加入衣橱并试穿，可用滑块或拖动手柄微调");
    } catch (e) {
      console.error(e);
      toast("衣服处理失败");
      setStatus("");
    }
  }

  async function importCurated() {
    setStatus("正在导入精选单品…");
    try {
      for (const c of CURATED) {
        if (state.wardrobe.some((x) => x.id === c.id)) continue;
        const img = await loadImg(c.src);
        const raw = document.createElement("canvas");
        raw.width = img.naturalWidth || img.width;
        raw.height = img.naturalHeight || img.height;
        raw.getContext("2d").drawImage(img, 0, 0);
        const cut = await cutout(raw, { preferFlood: true });
        await addToWardrobe({ id: c.id, name: c.name, kind: c.kind, canvas: cut });
      }
      toast("已将精选单品放入衣橱");
    } catch (e) {
      console.error(e);
      toast("导入失败");
    } finally {
      setStatus("");
    }
  }

  async function restoreWardrobe() {
    if (!db) return;
    try {
      const rows = await dbAll();
      rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const r of rows) {
        if (!r.blob) continue;
        const canvas = await blobToCanvas(r.blob);
        state.wardrobe.push({ id: r.id, name: r.name, kind: r.kind, canvas });
      }
      renderWardrobe();
    } catch (e) {
      console.warn("restore wardrobe", e);
    }
  }

  async function downloadPNG() {
    const src = activeView();
    if (!src) return;
    const c = document.createElement("canvas");
    c.width = src.w;
    c.height = src.h;
    render({ canvas: c, handles: false });
    const blob = await canvasToBlob(c, "image/png");
    const a = document.createElement("a");
    const t = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    a.download = `试穿效果-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate() + 0)}-${pad(t.getHours())}${pad(t.getMinutes())}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("已开始下载效果图");
  }

  /* ——— mode switch ——— */
  function setMode(mode) {
    const custom = mode === "custom";
    document.body.classList.toggle("is-custom", custom);
    const studio = $("#custom-studio");
    studio.hidden = !custom;
    $("#tab-curated").classList.toggle("is-on", !custom);
    $("#tab-custom").classList.toggle("is-on", custom);
    $("#tab-curated").setAttribute("aria-selected", String(!custom));
    $("#tab-custom").setAttribute("aria-selected", String(custom));
    const hint = $("#mode-hint");
    if (hint) {
      hint.textContent = custom
        ? "上传照片与衣服，可贴图预览或使用 AI 试穿"
        : "两侧滑动，拖到模特身上，或点击单品试穿";
    }
    if (custom) {
      openStudio();
      requestAnimationFrame(() => layoutCanvas());
    }
  }

  async function openStudio() {
    if (!state.opened) {
      state.opened = true;
      try {
        db = await openDB();
        await restoreWardrobe();
      } catch (e) {
        console.warn("idb", e);
      }
      await loadEngine();
      if (!state.model) {
        try {
          await setModelFromSource(DEFAULT_MODEL, { label: "默认模特" });
        } catch {
          await setModelFromSource(FALLBACK_MODEL, { label: "默认模特" });
        }
      }
      readyResolve();
    } else {
      layoutCanvas();
    }
  }

  function bindUI() {
    $("#tab-curated").addEventListener("click", () => setMode("curated"));
    $("#tab-custom").addEventListener("click", () => setMode("custom"));
    $("#upload-model").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) onModelUpload(f);
    });
    $("#upload-face").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) onFaceUpload(f);
    });
    $("#upload-garment").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) onGarmentUpload(f);
    });
    $("#use-default-model").addEventListener("click", async () => {
      await setModelFromSource(DEFAULT_MODEL, { label: "默认模特" });
      toast("已恢复默认模特");
    });
    $("#use-curated-model").addEventListener("click", async () => {
      const src = window.FR && window.FR.currentComboSrc ? window.FR.currentComboSrc() : FALLBACK_MODEL;
      await setModelFromSource(src, { label: "精选模特" });
      toast("已使用当前精选搭配作为模特");
    });
    $("#import-curated").addEventListener("click", importCurated);
    $("#download-png").addEventListener("click", downloadPNG);
    $("#show-pose").addEventListener("change", (e) => {
      state.showPose = e.target.checked;
      render();
    });
    $$(".kind-toggle [data-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.uploadKind = btn.dataset.kind;
        $$(".kind-toggle [data-kind]").forEach((b) => b.classList.toggle("is-on", b === btn));
      });
    });
    $("#wardrobe").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const id = del.dataset.del;
        const item = state.wardrobe.find((x) => x.id === id);
        if (item && state.worn[item.kind] && state.worn[item.kind].id === id) takeOff(item.kind);
        state.wardrobe = state.wardrobe.filter((x) => x.id !== id);
        if (db) dbDel(id);
        renderWardrobe();
        return;
      }
      const card = e.target.closest(".ward-item");
      if (!card) return;
      const item = state.wardrobe.find((x) => x.id === card.dataset.id);
      if (item) wear(item, { reset: true });
    });
    bindSliders();
    bindCanvas();
    window.addEventListener("resize", () => {
      if (document.body.classList.contains("is-custom")) layoutCanvas();
    });
  }

  function boot() {
    bindUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }


  function flattenOnWhite(src) {
    const c = document.createElement("canvas");
    c.width = src.width || src.w;
    c.height = src.height || src.h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src.canvas || src, 0, 0, c.width, c.height);
    return c;
  }

  async function canvasToFile(canvas, name, type = "image/jpeg", quality = 0.92) {
    const blob = await canvasToBlob(canvas, type, quality);
    return new File([blob], name, { type: blob.type || type });
  }

  function pickGarmentItem() {
    const fromWorn = (kind) => {
      const layer = state.worn[kind];
      if (!layer) return null;
      return state.wardrobe.find((x) => x.id === layer.id) || layer;
    };
    if (state.selected && state.worn[state.selected]) return fromWorn(state.selected);
    return fromWorn("jacket") || fromWorn("pants") ||
      state.wardrobe.find((x) => x.kind === "jacket") ||
      state.wardrobe[0] ||
      null;
  }

  async function getTryOnInputs() {
    if (!state.model || !state.model.canvas) {
      return { error: "请先上传或选择模特照片" };
    }
    const item = pickGarmentItem();
    if (!item || !item.canvas) {
      return { error: "请先上传并选择一件衣服" };
    }
    const personFile = await canvasToFile(state.model.canvas, "person.jpg");
    const garmentFile = await canvasToFile(flattenOnWhite(item.canvas), "garment.jpg");
    return {
      personFile,
      garmentFile,
      name: item.name || "",
      kind: item.kind || "jacket",
    };
  }

  function setAIResult(source, meta) {
    let canvas = source;
    if (!(source instanceof HTMLCanvasElement)) {
      canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth || source.width;
      canvas.height = source.naturalHeight || source.height;
      canvas.getContext("2d").drawImage(source, 0, 0);
    }
    state.aiResult = {
      canvas,
      w: canvas.width,
      h: canvas.height,
      meta: meta || {},
    };
    state.viewMode = "ai";
    try {
      window.dispatchEvent(new CustomEvent("fr-ai-view", { detail: { mode: "ai", meta: state.aiResult.meta } }));
    } catch (_) {}
    layoutCanvas();
  }

  function setViewMode(mode) {
    if (mode === "ai" && !state.aiResult) return;
    state.viewMode = mode === "ai" ? "ai" : "overlay";
    try {
      window.dispatchEvent(new CustomEvent("fr-ai-view", { detail: { mode: state.viewMode } }));
    } catch (_) {}
    layoutCanvas();
  }

  window.CustomTryOn = {
    whenReady: () => readyPromise,
    getState: () => ({
      engineReady: state.engineReady,
      engineError: state.engineError && String(state.engineError),
      mpDelegate: state.mpDelegate || null,
      hasModel: !!state.model,
      modelSize: state.model ? { w: state.model.w, h: state.model.h } : null,
      landmarkCount: state.landmarks ? state.landmarks.length : 0,
      poseOk: !!(state.landmarks && !bodyMetrics(state.landmarks, state.model.w, state.model.h).fallback),
      worn: {
        jacket: state.worn.jacket && { id: state.worn.jacket.id, name: state.worn.jacket.name, cx: state.worn.jacket.cx, cy: state.worn.jacket.cy, width: state.worn.jacket.width, height: state.worn.jacket.height },
        pants: state.worn.pants && { id: state.worn.pants.id, name: state.worn.pants.name, cx: state.worn.pants.cx, cy: state.worn.pants.cy, width: state.worn.pants.width, height: state.worn.pants.height },
      },
      wardrobe: state.wardrobe.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
      selected: state.selected,
      viewMode: state.viewMode,
      hasAIResult: !!state.aiResult,
      aiMeta: state.aiResult ? state.aiResult.meta : null,
    }),
    setMode,
    importCurated,
    wearById: (id) => {
      const item = state.wardrobe.find((x) => x.id === id);
      if (item) wear(item, { reset: true });
    },
    layoutCanvas,
    render,
    getTryOnInputs,
    setAIResult,
    setViewMode,
    pickGarmentItem,
  };
})();
