/* Fitting Room — virtual try-on */

const JACKETS = [
  { id: "crimson",    name: "朱红拉链帽衫",     price: 129, img: "assets/jacket-crimson.jpg" },
  { id: "camel",      name: "驼色灯芯绒羽绒服", price: 189, img: "assets/jacket-camel.jpg" },
  { id: "colorblock", name: "岩灰拼色防风衣",   price: 159, img: "assets/jacket-colorblock.jpg" },
  { id: "mist",       name: "雾蓝连帽羽绒服",   price: 199, img: "assets/jacket-mist.jpg" },
];

const PANTS = [
  { id: "black", name: "墨黑工装裤",       price: 99,  img: "assets/pants-black.jpg" },
  { id: "olive", name: "橄榄侧条工装裤",   price: 109, img: "assets/pants-olive.jpg" },
  { id: "sand",  name: "沙色摇粒绒束脚裤", price: 89,  img: "assets/pants-sand.jpg" },
  { id: "khaki", name: "亚麻阔腿裤",       price: 95,  img: "assets/pants-khaki.jpg" },
];

const KIND = { jacket: "外套", pants: "裤装" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  jacket: "camel",
  pants: "sand",
  cart: [], // { id, kind, name, price, img, qty }
  fading: false,
  pendingSrc: null,
  visible: "a",
};

function comboSrc(jacket, pants) {
  return `assets/model-${jacket}-${pants}.jpg`;
}

function findItem(kind, id) {
  return (kind === "jacket" ? JACKETS : PANTS).find((x) => x.id === id);
}

function euro(n) {
  return "€" + n.toFixed(0);
}

/* ——— Render pieces ——— */

function renderStrips() {
  const jStrip = $("#jackets-strip");
  const pStrip = $("#pants-strip");
  jStrip.innerHTML = JACKETS.map((item, i) => pieceHTML(item, "jacket", i)).join("");
  pStrip.innerHTML = PANTS.map((item, i) => pieceHTML(item, "pants", i)).join("");
  $$(".piece").forEach(bindPiece);
  syncSelection();
}

function pieceHTML(item, kind, slot) {
  return `
    <button type="button" class="piece" data-kind="${kind}" data-id="${item.id}" data-slot="${slot}"
      aria-label="试穿${KIND[kind]}：${item.name}，${euro(item.price)}"
      aria-pressed="false">
      <img src="${item.img}" alt="${item.name}">
    </button>`;
}

function syncSelection() {
  $$(".piece").forEach((el) => {
    const on = el.dataset.id === state[el.dataset.kind];
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const j = findItem("jacket", state.jacket);
  const p = findItem("pants", state.pants);
  $("#jacket-name").textContent = j.name;
  $("#pants-name").textContent = p.name;
  const img = state.visible === "a" ? $("#model-a") : $("#model-b");
  img.alt = `模特正穿着${j.name}与${p.name}`;
}

/* ——— Try-on + crossfade ——— */

function tryOn(kind, id) {
  if (state[kind] === id) return;
  state[kind] = id;
  syncSelection();
  swapModel(comboSrc(state.jacket, state.pants));
}

function swapModel(src) {
  if (state.fading) {
    state.pendingSrc = src;
    return;
  }
  const vis = state.visible === "a" ? $("#model-a") : $("#model-b");
  const next = state.visible === "a" ? $("#model-b") : $("#model-a");
  if (vis.getAttribute("src") === src) return;

  const reveal = () => {
    state.fading = true;
    next.classList.add("is-visible");
    vis.classList.remove("is-visible");
    let settled = false;
    const done = (ev) => {
      if (settled) return;
      if (ev && ev.propertyName && ev.propertyName !== "opacity") return;
      settled = true;
      next.removeEventListener("transitionend", done);
      state.visible = state.visible === "a" ? "b" : "a";
      state.fading = false;
      const j = findItem("jacket", state.jacket);
      const p = findItem("pants", state.pants);
      next.alt = `模特正穿着${j.name}与${p.name}`;
      vis.alt = "";
      vis.setAttribute("aria-hidden", "true");
      next.removeAttribute("aria-hidden");
      if (state.pendingSrc && state.pendingSrc !== src) {
        const pending = state.pendingSrc;
        state.pendingSrc = null;
        swapModel(pending);
      } else {
        state.pendingSrc = null;
      }
    };
    next.addEventListener("transitionend", done);
    // safety if transitionend doesn't fire (reduced motion / already visible)
    setTimeout(done, 650);
  };

  if (next.getAttribute("src") === src && next.complete) {
    reveal();
    return;
  }
  next.onload = () => {
    next.onload = null;
    reveal();
  };
  next.onerror = () => {
    next.onerror = null;
    state.fading = false;
  };
  next.src = src;
}

function preloadAll() {
  JACKETS.forEach((j) => {
    PANTS.forEach((p) => {
      const img = new Image();
      img.src = comboSrc(j.id, p.id);
    });
  });
  [...JACKETS, ...PANTS].forEach((x) => {
    const img = new Image();
    img.src = x.img;
  });
}

/* ——— Pointer drag ——— */

function bindPiece(el) {
  const kind = el.dataset.kind;
  const id = el.dataset.id;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let ghost = null;
  const THRESH = 8;

  const cleanup = () => {
    if (pointerId !== null) {
      try { el.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
    }
    pointerId = null;
    dragging = false;
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    el.classList.remove("is-source");
    document.body.classList.remove("is-dragging");
    $("#model-wrap").classList.remove("drop-ready");
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) > THRESH) {
      dragging = true;
      el._suppressClick = true;
      el.classList.add("is-source");
      document.body.classList.add("is-dragging");
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = `<img src="${findItem(kind, id).img}" alt="">`;
      document.body.appendChild(ghost);
    }
    if (dragging && ghost) {
      ghost.style.left = e.clientX + "px";
      ghost.style.top = e.clientY + "px";
      const wrap = $("#model-wrap");
      // hide ghost briefly so elementFromPoint can see what's underneath
      ghost.style.visibility = "hidden";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      ghost.style.visibility = "";
      const over = under && (under.closest("#model-wrap") || under.id === "model-wrap");
      wrap.classList.toggle("drop-ready", Boolean(over));
    }
  });

  el.addEventListener("pointerup", (e) => {
    if (pointerId !== e.pointerId) return;
    if (dragging && ghost) {
      ghost.style.visibility = "hidden";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      ghost.style.visibility = "";
      const over = under && (under.closest("#model-wrap") || under.id === "model-wrap");
      if (over) tryOn(kind, id);
    }
    cleanup();
  });

  el.addEventListener("pointercancel", cleanup);

  el.addEventListener("click", () => {
    if (el._suppressClick) {
      el._suppressClick = false;
      return;
    }
    tryOn(kind, id);
  });

  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      tryOn(kind, id);
    }
  });
}

/* ——— Cart ——— */

function addToCart(kind, id, silent) {
  const item = findItem(kind, id);
  const existing = state.cart.find((x) => x.kind === kind && x.id === id);
  if (existing) existing.qty += 1;
  else state.cart.push({ ...item, kind, qty: 1 });
  renderCart();
  if (!silent) {
    toast(`已加入购物车：${item.name}`);
    popCount();
  }
}

function removeFromCart(kind, id) {
  state.cart = state.cart.filter((x) => !(x.kind === kind && x.id === id));
  renderCart();
}

function setQty(kind, id, qty) {
  const existing = state.cart.find((x) => x.kind === kind && x.id === id);
  if (!existing) return;
  if (qty <= 0) removeFromCart(kind, id);
  else {
    existing.qty = qty;
    renderCart();
  }
}

function cartCount() {
  return state.cart.reduce((n, x) => n + x.qty, 0);
}

function cartTotal() {
  return state.cart.reduce((n, x) => n + x.price * x.qty, 0);
}

function renderCart() {
  const n = cartCount();
  const countEl = $("#cart-count");
  countEl.textContent = n;
  $("#cart-btn").setAttribute("aria-label", `打开购物车，当前 ${n} 件`);
  $("#cart-total").textContent = euro(cartTotal());
  $("#checkout-btn").disabled = n === 0;

  const list = $("#cart-list");
  if (n === 0) {
    list.innerHTML = `<p class="cart-empty">购物车是空的。<br>试穿后，点击芯片或「加入购物车」即可放入单品。</p>`;
    return;
  }
  list.innerHTML = state.cart.map((x) => `
    <article class="cart-item" data-kind="${x.kind}" data-id="${x.id}">
      <img src="${x.img}" alt="${x.name}">
      <div class="cart-item-info">
        <p class="cart-item-kind">${KIND[x.kind]}</p>
        <p class="cart-item-name">${x.name}</p>
        <div class="cart-item-meta">
          <div class="qty-ctrl">
            <button type="button" data-act="dec" aria-label="减少数量">−</button>
            <span>${x.qty}</span>
            <button type="button" data-act="inc" aria-label="增加数量">+</button>
          </div>
          <button type="button" class="remove-btn" data-act="rm">移除</button>
        </div>
      </div>
      <p class="cart-item-price">${euro(x.price * x.qty)}</p>
    </article>
  `).join("");

  list.querySelectorAll(".cart-item").forEach((row) => {
    const { kind, id } = row.dataset;
    row.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      const item = state.cart.find((x) => x.kind === kind && x.id === id);
      if (act === "inc") setQty(kind, id, (item?.qty || 0) + 1);
      if (act === "dec") setQty(kind, id, (item?.qty || 1) - 1);
      if (act === "rm") removeFromCart(kind, id);
    });
  });
}

function popCount() {
  const el = $("#cart-count");
  el.classList.remove("is-pop");
  void el.offsetWidth;
  el.classList.add("is-pop");
  setTimeout(() => el.classList.remove("is-pop"), 350);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 1800);
}

function openCart() {
  const drawer = $("#cart-drawer");
  const backdrop = $("#backdrop");
  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  $("#cart-btn").setAttribute("aria-expanded", "true");
  $("#close-cart").focus();
  document.addEventListener("keydown", onEsc);
}

function closeCart() {
  const drawer = $("#cart-drawer");
  const backdrop = $("#backdrop");
  drawer.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  $("#cart-btn").setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onEsc);
  const hide = () => {
    drawer.hidden = true;
    backdrop.hidden = true;
    drawer.removeEventListener("transitionend", hide);
  };
  drawer.addEventListener("transitionend", hide);
  setTimeout(hide, 500);
  $("#cart-btn").focus();
}

function onEsc(e) {
  if (e.key === "Escape") closeCart();
}

/* ——— Boot ——— */

function boot() {
  renderStrips();
  renderCart();
  preloadAll();

  $("#chip-jacket").addEventListener("click", () => addToCart("jacket", state.jacket));
  $("#chip-pants").addEventListener("click", () => addToCart("pants", state.pants));
  $("#add-btn").addEventListener("click", () => {
    addToCart("jacket", state.jacket, true);
    addToCart("pants", state.pants, true);
    const j = findItem("jacket", state.jacket);
    const p = findItem("pants", state.pants);
    toast(`已加入套装：${j.name}、${p.name}`);
    popCount();
  });

  $("#cart-btn").addEventListener("click", openCart);
  $("#close-cart").addEventListener("click", closeCart);
  $("#backdrop").addEventListener("click", closeCart);

  $("#checkout-btn").addEventListener("click", () => {
    if (cartCount() === 0) return;
    toast("此为演示站点，无法真实结算");
  });
}

document.addEventListener("DOMContentLoaded", boot);
