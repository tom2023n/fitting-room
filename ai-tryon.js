/* Fitting Room — AI try-on via public Hugging Face Gradio Spaces.
   No backend, no paid keys. Uses @gradio/client from a CDN. */
(function () {
  "use strict";

  const GRADIO_CANDIDATES = [
    "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/+esm",
    "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/index.min.js",
    "https://unpkg.com/@gradio/client@2.8.0/+esm",
  ];

  const SPACES = [
    {
      id: "yisol/IDM-VTON",
      url: "https://yisol-idm-vton.hf.space",
      kind: "idm",
      label: "IDM-VTON",
    },
    {
      id: "zhengchong/CatVTON",
      url: "https://zhengchong-catvton.hf.space",
      kind: "cat",
      label: "CatVTON",
    },
  ];

  const INFER_TIMEOUT_MS = 180000;
  const CONNECT_TIMEOUT_MS = 50000;
  const TOKEN_KEY = "fr-hf-token";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const toast = (m) => (window.FR && window.FR.toast ? window.FR.toast(m) : console.log(m));

  const aiState = {
    running: false,
    lastSpace: null,
    lastError: null,
    lastElapsed: null,
    clothType: "upper",
    job: null,
    clientMod: null,
  };

  function getToken() {
    const input = $("#ai-token");
    let v = (input && input.value.trim()) || "";
    if (!v) {
      try { v = localStorage.getItem(TOKEN_KEY) || ""; } catch (_) {}
    }
    if (v && !v.startsWith("hf_")) return null;
    return v || null;
  }

  function saveToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  function setStatus(msg, kind) {
    ["#ai-status", "#ai-status-stage"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.textContent = msg || "";
      el.classList.toggle("is-error", kind === "error");
      el.classList.toggle("is-ok", kind === "ok");
    });
  }

  function setRunning(on) {
    aiState.running = on;
    $$(".ai-run-btn").forEach((b) => {
      b.disabled = on;
      b.textContent = on ? "正在生成…" : "AI 试穿（免费在线模型）";
    });
  }

  function syncViewToggle() {
    const wrap = $("#ai-view-toggle");
    if (!wrap || !window.CustomTryOn) return;
    const st = window.CustomTryOn.getState();
    wrap.hidden = !st.hasAIResult;
    const mode = st.viewMode;
    $("#view-ai") && $("#view-ai").classList.toggle("is-on", mode === "ai");
    $("#view-overlay") && $("#view-overlay").classList.toggle("is-on", mode !== "ai");
  }

  function explainError(err) {
    const text = err && (err.message || String(err)) || "";
    const raw = text.toLowerCase();
    if (/quota|exceeded|rate.?limit|429|gpu (hours|quota|limit)|zero.?gpu|out of (gpu|credit)|too many request|resourceexhausted|limit exceeded/i.test(raw)) {
      return "免费额度用完或排队中，请稍后重试，或继续使用贴图预览";
    }
    if (/busy|queue (is )?full|currently busy|try again later/i.test(raw)) {
      return "免费额度用完或排队中，请稍后重试，或继续使用贴图预览";
    }
    if (/sleep|starting|waking|building|startup|app_starting|loading the space|space is (not ready|starting)/i.test(raw)) {
      return "演示模型正在启动，请稍候再试（约一分钟），或继续使用贴图预览";
    }
    if (/503|runtime|paused|not available|could not resolve|metadata could not|space_error|no app file/i.test(raw)) {
      return "在线模型暂时不可用，请稍后重试，或继续使用贴图预览";
    }
    if (/failed to fetch|networkerror|network|cors|load failed|err_connection|err_timed|aborted|timeout/i.test(raw)) {
      return "无法连接到在线模型，请检查网络后重试，或继续使用贴图预览";
    }
    const short = text.replace(/\s+/g, " ").slice(0, 140);
    return (short ? "生成失败：" + short + "。" : "生成失败。") + "可稍后重试，或继续使用贴图预览";
  }

  function withTimeout(promise, ms, label) {
    let tid;
    const t = new Promise((_, rej) => {
      tid = setTimeout(() => rej(new Error(label || "timeout")), ms);
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(tid));
  }

  async function loadGradio() {
    if (aiState.clientMod) return aiState.clientMod;
    let last = null;
    for (const url of GRADIO_CANDIDATES) {
      try {
        const mod = await import(url);
        if (mod && mod.Client) {
          aiState.clientMod = mod;
          console.info("Gradio client loaded", url);
          return mod;
        }
      } catch (e) {
        last = e;
        console.warn("Gradio candidate failed", url, e);
      }
    }
    throw last || new Error("无法加载 Gradio 客户端");
  }

  function findCatEndpoints(api) {
    const entries = [
      ...Object.entries((api && api.named_endpoints) || {}),
      ...Object.entries((api && api.unnamed_endpoints) || {}),
    ];
    const hits = [];
    for (const [name, ep] of entries) {
      const params = (ep.parameters || []).map((p) => p.parameter_name);
      const hasPerson = params.includes("person_image") || params[0] === "person_image";
      const hasCloth = params.includes("cloth_image");
      if (hasPerson && hasCloth) {
        hits.push({ name, params, hasClothType: params.includes("cloth_type") });
      }
    }
    // Prefer the mask-based SD endpoint (has cloth_type) over Flux/p2p; first listed is SD in the Space.
    hits.sort((a, b) => Number(b.hasClothType) - Number(a.hasClothType));
    return hits;
  }

  async function connectSpace(space, onStatus) {
    const { Client } = await loadGradio();
    const opts = {
      events: ["status", "data", "log"],
      status_callback: (s) => {
        if (!s) return;
        if (s.status === "sleeping" || s.status === "starting" || s.detail === "SLEEPING" || s.detail === "APP_STARTING") {
          onStatus("正在唤醒 " + space.label + " 演示模型…");
        } else if (s.status === "running" || s.detail === "RUNNING") {
          onStatus("已连接到 " + space.label + "，准备生成…");
        } else if (s.status === "error" || s.status === "space_error" || s.status === "paused") {
          onStatus(space.label + " 暂时不可用");
        }
      },
    };
    const token = getToken();
    if (token) opts.token = token;
    const client = await withTimeout(
      Client.connect(space.url, opts),
      CONNECT_TIMEOUT_MS,
      space.label + " 连接超时"
    );
    let api = null;
    try { api = await client.view_api(); } catch (e) { console.warn("view_api", e); }
    return { client, api };
  }

  function formatQueue(msg) {
    const pos = msg.position;
    const size = msg.size;
    const eta = msg.eta;
    let s = "排队中";
    if (typeof pos === "number") s += "，前面还有 " + pos + " 人";
    else if (typeof size === "number" && size > 1) s += "，队列 " + size + " 人";
    if (typeof eta === "number" && eta > 0) s += "，大约 " + Math.max(1, Math.round(eta)) + " 秒";
    s += "…";
    return s;
  }

  async function submitJob(client, endpoint, payload, onStatus) {
    const job = client.submit(endpoint, payload, undefined, null, true);
    aiState.job = job;
    let result = null;
    let err = null;
    const deadline = Date.now() + INFER_TIMEOUT_MS;

    const iter = (async () => {
      for await (const msg of job) {
        if (Date.now() > deadline) throw new Error("timeout");
        if (msg.type === "status") {
          if (msg.stage === "error") {
            const m = msg.message;
            err = new Error(typeof m === "string" ? m : (Array.isArray(m) ? m.map((x) => x.message || x).join("; ") : JSON.stringify(m || msg)));
            break;
          }
          if (msg.stage === "pending" && msg.queue) onStatus(formatQueue(msg));
          else if (msg.stage === "generating" || msg.stage === "streaming") {
            let s = "正在生成试穿效果，约 30–90 秒，请稍候…";
            if (msg.progress_data && msg.progress_data[0]) {
              const p = msg.progress_data[0];
              if (p.length && typeof p.index === "number") s = "正在生成… " + (p.index + 1) + "/" + p.length + (p.unit ? " " + p.unit : "");
              else if (p.desc) s = "正在生成… " + p.desc;
            }
            onStatus(s);
          } else if (msg.stage === "complete") {
            onStatus("正在读取结果…");
          }
        } else if (msg.type === "log") {
          if (msg.level === "error") console.warn("space log", msg.log);
          else console.info("space log", msg.log);
        } else if (msg.type === "data") {
          result = msg;
        }
      }
    })();

    await withTimeout(iter, INFER_TIMEOUT_MS, "timeout");
    if (err) throw err;
    if (!result) throw new Error("模型没有返回结果");
    return result;
  }

  function firstImage(data) {
    if (data == null) return null;
    if (Array.isArray(data)) {
      for (const item of data) {
        const f = firstImage(item);
        if (f) return f;
      }
      return null;
    }
    if (typeof data === "string") return data;
    if (typeof data === "object") {
      if (data.url || data.path) return data;
    }
    return null;
  }

  async function itemToCanvas(item) {
    if (!item) throw new Error("空结果");
    if (item instanceof HTMLCanvasElement) return item;
    let url = null;
    if (typeof item === "string") url = item;
    else if (item.url) url = item.url;
    else if (item.path && /^https?:/i.test(item.path)) url = item.path;
    if (!url) throw new Error("无法解析结果图片");
    const res = await fetch(url);
    if (!res.ok) throw new Error("下载结果失败 " + res.status);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return c;
  }

  function idmPayload(inputs, desc) {
    return {
      dict: { background: inputs.personFile, layers: [], composite: null },
      garm_img: inputs.garmentFile,
      garment_des: desc || inputs.name || "a fashionable garment",
      is_checked: true,
      is_checked_crop: false,
      denoise_steps: 30,
      seed: 42,
    };
  }

  function catPayload(inputs, clothType, paramNames) {
    const payload = {
      person_image: { background: inputs.personFile, layers: [], composite: null },
      cloth_image: inputs.garmentFile,
      cloth_type: clothType,
      num_inference_steps: 30,
      guidance_scale: 2.5,
      seed: 42,
      show_type: "result only",
    };
    if (paramNames && !paramNames.includes("cloth_type")) delete payload.cloth_type;
    if (paramNames && !paramNames.includes("show_type")) delete payload.show_type;
    return payload;
  }

  function preferredOrder(clothType) {
    // IDM-VTON is mainly upper-body; CatVTON supports upper/lower/overall.
    if (clothType === "lower" || clothType === "overall") {
      return [SPACES[1], SPACES[0]];
    }
    return SPACES.slice();
  }

  async function tryOneSpace(space, inputs, desc, clothType, onStatus) {
    onStatus("正在连接 " + space.label + "…");
    const { client, api } = await connectSpace(space, onStatus);
    try {
      if (space.kind === "idm") {
        const hasTryon = api && api.named_endpoints && api.named_endpoints["/tryon"];
        if (api && !hasTryon) throw new Error("IDM-VTON 接口已变更（找不到 /tryon）");
        onStatus("已连接 " + space.label + "，正在生成（约 30–90 秒）…");
        const result = await submitJob(client, "/tryon", idmPayload(inputs, desc), onStatus);
        const canvas = await itemToCanvas(firstImage(result.data));
        return { canvas, space, endpoint: "/tryon" };
      }
      const endpoints = findCatEndpoints(api);
      if (!endpoints.length) throw new Error("CatVTON 接口已变更或无法识别");
      let lastErr = null;
      for (const ep of endpoints) {
        try {
          onStatus("已连接 " + space.label + "，正在生成（约 30–90 秒）…");
          const result = await submitJob(client, ep.name, catPayload(inputs, clothType, ep.params), onStatus);
          const canvas = await itemToCanvas(firstImage(result.data));
          return { canvas, space, endpoint: ep.name };
        } catch (e) {
          lastErr = e;
          console.warn("CatVTON endpoint failed", ep.name, e);
        }
      }
      throw lastErr || new Error("CatVTON 生成失败");
    } finally {
      try { client.close(); } catch (_) {}
      aiState.job = null;
    }
  }

  function defaultDesc(inputs) {
    const el = $("#ai-desc");
    const typed = el && el.value.trim();
    if (typed) return typed;
    return (inputs && inputs.name) || "";
  }

  function fillDescIfEmpty(name) {
    const el = $("#ai-desc");
    if (!el) return;
    if (!el.dataset.touched || !el.value.trim()) {
      el.value = name || "";
      el.dataset.touched = "";
    }
  }

  function syncClothFromGarment() {
    if (!window.CustomTryOn || !window.CustomTryOn.pickGarmentItem) return;
    const item = window.CustomTryOn.pickGarmentItem();
    if (!item) return;
    fillDescIfEmpty(item.name);
    if (item.kind === "pants" && aiState.clothType === "upper") setClothType("lower");
    if (item.kind === "jacket" && aiState.clothType === "lower") setClothType("upper");
  }

  function setClothType(type) {
    aiState.clothType = type;
    $$("[data-ai-cloth]").forEach((b) => b.classList.toggle("is-on", b.dataset.aiCloth === type));
  }

  async function runAI(opts) {
    if (aiState.running) return { error: "already running" };
    if (!window.CustomTryOn) return { error: "studio not ready" };
    const inputs = opts && opts.inputs ? opts.inputs : await window.CustomTryOn.getTryOnInputs();
    if (inputs.error) {
      setStatus(inputs.error, "error");
      toast(inputs.error);
      return inputs;
    }
    const desc = (opts && opts.desc) || defaultDesc(inputs);
    const clothType = (opts && opts.clothType) || aiState.clothType || (inputs.kind === "pants" ? "lower" : "upper");
    const t0 = Date.now();
    setRunning(true);
    setStatus("正在准备图像并连接免费在线模型…");
    const order = preferredOrder(clothType);
    const errors = [];
    try {
      await loadGradio();
      for (const space of order) {
        try {
          const out = await tryOneSpace(space, inputs, desc, clothType, setStatus);
          const elapsed = Date.now() - t0;
          aiState.lastSpace = space.id;
          aiState.lastElapsed = elapsed;
          aiState.lastError = null;
          window.CustomTryOn.setAIResult(out.canvas, {
            space: space.id,
            label: space.label,
            endpoint: out.endpoint,
            elapsed,
            desc,
            clothType,
          });
          syncViewToggle();
          const secs = Math.max(1, Math.round(elapsed / 1000));
          setStatus("已用 " + space.label + " 生成，用时 " + secs + " 秒。可下载效果图，或切回贴图预览。", "ok");
          toast("AI 试穿完成（" + space.label + "，" + secs + " 秒）");
          return { ok: true, space: space.id, elapsed };
        } catch (e) {
          console.warn("space failed", space.id, e);
          errors.push({ space: space.id, error: e && e.message ? e.message : String(e) });
          setStatus(space.label + " 未成功，尝试备用模型…");
        }
      }
      const combined = errors.map((e) => e.space + ": " + e.error).join(" | ");
      const pretty = explainError(new Error(combined || "all spaces failed"));
      aiState.lastError = pretty;
      setStatus(pretty, "error");
      toast(pretty);
      return { error: pretty, details: errors };
    } catch (e) {
      const pretty = explainError(e);
      aiState.lastError = pretty;
      setStatus(pretty, "error");
      toast(pretty);
      return { error: pretty };
    } finally {
      setRunning(false);
    }
  }

  function bindUI() {
    const run = (e) => {
      if (e) e.preventDefault();
      runAI();
    };
    const a = $("#ai-run");
    const b = $("#ai-run-toolbar");
    if (a) a.addEventListener("click", run);
    if (b) b.addEventListener("click", run);

    $$("[data-ai-cloth]").forEach((btn) => {
      btn.addEventListener("click", () => setClothType(btn.dataset.aiCloth));
    });

    const desc = $("#ai-desc");
    if (desc) {
      desc.addEventListener("input", () => { desc.dataset.touched = "1"; });
    }

    const token = $("#ai-token");
    if (token) {
      try { token.value = localStorage.getItem(TOKEN_KEY) || ""; } catch (_) {}
      token.addEventListener("change", () => saveToken(token.value.trim()));
    }

    const viewAi = $("#view-ai");
    const viewOv = $("#view-overlay");
    if (viewAi) viewAi.addEventListener("click", () => window.CustomTryOn && window.CustomTryOn.setViewMode("ai"));
    if (viewOv) viewOv.addEventListener("click", () => window.CustomTryOn && window.CustomTryOn.setViewMode("overlay"));
    window.addEventListener("fr-ai-view", syncViewToggle);

    // When a wardrobe item is worn, refresh default description.
    const wardrobe = $("#wardrobe");
    if (wardrobe) {
      wardrobe.addEventListener("click", () => setTimeout(syncClothFromGarment, 0));
    }
  }

  function boot() {
    bindUI();
    syncViewToggle();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.AITryOn = {
    run: runAI,
    setClothType,
    getState: () => ({
      running: aiState.running,
      lastSpace: aiState.lastSpace,
      lastElapsed: aiState.lastElapsed,
      lastError: aiState.lastError,
      clothType: aiState.clothType,
    }),
    explainError,
  };
})();
