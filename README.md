# 试衣间 · Fitting Room

静态虚拟试衣站点，两种模式，适合 GitHub Pages。无需自建后端或付费 API 密钥。

线上：https://tom2023n.github.io/fitting-room/

## 精选试衣

点击或把单品拖到模特身上，即可换上对应外套与裤装（16 套预先生成的试穿图，交叉淡入淡出）。

- 点击两侧单品，或拖到模特身上试穿
- 点击底部芯片可将当前外套或裤装加入购物车；「加入购物车」一次放入整套
- 价格为虚构演示（欧元），无法真实结算
- 窄屏下，外套与裤装变为模特上下的横向滑动列表

## 自定义试穿

上传自己的照片和衣服图片。提供两种方式：

### 贴图预览（本地）

照片只在你的浏览器里处理，不会上传。用 MediaPipe Pose 识别肩、髋等关键点，把去底后的衣服贴到照片上，可用手柄和滑块微调。可同时叠加上衣 + 裤子。

### AI 试穿（免费在线模型）

把当前模特照片和选中的衣服发送到 Hugging Face 的公开演示，生成更自然的换装效果，大约 30–90 秒。

- 首选 [yisol/IDM-VTON](https://huggingface.co/spaces/yisol/IDM-VTON)（主要适合成衣上身）
- 备用 [zhengchong/CatVTON](https://huggingface.co/spaces/zhengchong/CatVTON)（支持上衣 / 裤子 / 全身；若该 Space 不可用会自动跳过）
- 通过官方 `@gradio/client` 从浏览器直接调用，不经过本站点服务器
- 受 Hugging Face ZeroGPU 免费额度限制；额度用完或排队时请稍后重试，或继续使用贴图预览
- 可选填写本机保存的 Hugging Face 令牌（`hf_…`）以提高免费额度，本站点不收集该令牌

商品链接无法直接抓取，请先把商品图保存到本地再上传。「下载效果图」可保存当前画面（AI 结果或贴图预览）。

## 本地预览

```bash
python3 -m http.server 8765
```

然后访问 http://127.0.0.1:8765/

## 文件

- `index.html` / `styles.css` / `app.js` / `custom.js` / `ai-tryon.js`
- `assets/` 产品图、默认模特，以及 16 张精选试穿组合图
