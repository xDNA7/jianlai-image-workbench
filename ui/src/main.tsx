// @ts-nocheck Legacy business UI remains behind the typed route and API boundaries during migration.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { SelectField } from "./components/ui/select";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Download,
  FileImage,
  Film,
  Heart,
  ImagePlus,
  Images,
  Loader2,
  Menu,
  MousePointer2,
  Plus,
  RotateCcw,
  Scan,
  Send,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import "./style.css";

const base = typeof window !== "undefined" && (window.location.pathname.startsWith("/jianlai-test/") || window.location.search.includes("testPath=1")) ? "/jianlai-test/" : "/jianlai/";
const assetBase = (import.meta.env.VITE_PUBLIC_ASSET_BASE || "https://public-assets.example/assets/").replace(/\/?$/, "/");
const ossBase = `${assetBase}jianlai/`;
const api = (path, options = {}) =>
  fetch(`${base}api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "请求失败");
    return data;
  });
const fallbackWorks = [
  ["templates/v2/fun-v2-deepsea.webp", "深海探索肖像"],
  ["templates/v2/fun-v2-double.webp", "双重曝光"],
  ["templates/v2/fun-v2-papertheater.webp", "纸艺剧场"],
  ["templates/v2/fun-v2-city.webp", "城市叙事"],
];
const assetUrl = (value) => {
  if (!value) return "";
  const s = String(value);
  if (s.startsWith("templates/")) {
    const path = s.slice("templates/".length);
    if (/\.(?:png|jpe?g|webp)$/i.test(path)) {
      return `${ossBase}templates/previews/${path.replace(/\.(?:png|jpe?g|webp)$/i, ".webp")}`;
    }
    return `${ossBase}${s}`;
  }
  return /^(https?:|data:)/.test(s)
    ? s
    : `${base}${s.replace(/^(?:\.\.\/|\/)+/, "")}`;
};
const fileData = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

function Header({
  quota,
  onAction,
  label = "进入工作台",
  mobile,
  setMobile,
  studio = false,
}) {
  const [localMobile, setLocalMobile] = useState(false);
  mobile = mobile ?? localMobile;
  setMobile = setMobile || setLocalMobile;
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 lg:px-8">
        <button
          className="flex items-center gap-3 text-left"
          onClick={onAction}
        >
          <span className="grid size-8 place-items-center rounded-md bg-neutral-950 text-white">
            <Sparkles className="size-4" />
          </span>
          <span className="text-sm font-semibold">剑来华东 · 生图工作站</span>
        </button>
        <div className="hidden items-center gap-3 sm:flex">
          <Badge>{quota == null ? "余额读取中" : `余额 ¥${(quota / 100).toFixed(2)}`}</Badge>
          <Button
            size="sm"
            variant={studio ? "outline" : "default"}
            onClick={onAction}
          >
            {label} <ArrowUpRight className="size-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="sm:hidden"
          onClick={() => setMobile(!mobile)}
          aria-label="打开菜单"
        >
          {mobile ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
      </div>
      {mobile && (
        <div className="border-t border-neutral-200 bg-white p-4 sm:hidden">
          <Badge className="mb-3">
            {quota == null ? "余额读取中" : `余额 ¥${(quota / 100).toFixed(2)}`}
          </Badge>
          <Button className="w-full" onClick={onAction}>
            {label}
          </Button>
        </div>
      )}
    </header>
  );
}

function Landing({ quota, enter, mobile, setMobile }) {
  const [visible, setVisible] = useState(false);
  const [activeWork, setActiveWork] = useState(0);
  const [workflowStep, setWorkflowStep] = useState(0);
  useEffect(() => setVisible(true), []);
  useEffect(() => {
    const workTimer = window.setInterval(() => setActiveWork((value) => (value + 1) % fallbackWorks.length), 4200);
    const stepTimer = window.setInterval(() => setWorkflowStep((value) => (value + 1) % 3), 2200);
    return () => { window.clearInterval(workTimer); window.clearInterval(stepTimer); };
  }, []);
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-950">
      <Header {...{ quota, mobile, setMobile }} onAction={enter} />
      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-16 lg:grid-cols-[.9fr_1.1fr] lg:px-8 lg:pb-28 lg:pt-24">
          <div className="max-w-xl">
            <Badge>
              <span className="mr-1.5 size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
              创作工作站
            </Badge>
            <h1
              className={`mt-6 text-5xl font-semibold leading-[.98] transition-[opacity,transform] duration-700 motion-reduce:transition-none sm:text-7xl ${visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`}
            >
              让灵感，
              <br />
              <span className="text-neutral-500 motion-safe:animate-pulse">有迹可循。</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-neutral-600">
              从一句描述开始，生成海报、人物与产品视觉。每次尝试都会留下下一步。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" onClick={enter}>
                开始创作 <ArrowUpRight className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="lg"
                onClick={() =>
                  document
                    .querySelector("#workflow")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                看看怎么工作
              </Button>
            </div>
            <div className="mt-10 flex items-center gap-3 text-xs text-neutral-500">
              <span className="flex -space-x-2">
                <span className="grid size-7 place-items-center rounded-full border-2 border-neutral-50 bg-neutral-200">
                  灵
                </span>
                <span className="grid size-7 place-items-center rounded-full border-2 border-neutral-50 bg-amber-100">
                  感
                </span>
                <span className="grid size-7 place-items-center rounded-full border-2 border-neutral-50 bg-lime-100">
                  ∞
                </span>
              </span>
              从想法到成片，每一步都在同一处
            </div>
          </div>
          <div className="relative motion-safe:animate-[bounce_6s_ease-in-out_infinite]">
            <Card className="group overflow-hidden transition-shadow duration-700 hover:shadow-xl">
              <img
                className="aspect-[1.08/1] w-full object-cover transition-[opacity,transform] duration-700 group-hover:scale-[1.02] motion-safe:animate-pulse"
                src={assetUrl(fallbackWorks[activeWork][0])}
                alt={fallbackWorks[activeWork][1]}
                fetchPriority="high"
                decoding="async"
              />
              <div className="flex items-center justify-between border-t border-neutral-200 bg-white px-4 py-3 text-xs">
                <span className="font-medium transition-opacity duration-500">灵感作品 · 0{activeWork + 1}</span>
                <span className="text-neutral-500 transition-opacity duration-500">{fallbackWorks[activeWork][1]}</span>
              </div>
            </Card>
            <Card className="absolute -bottom-5 left-4 flex items-center gap-3 px-3 py-2 transition-transform duration-700 hover:-translate-y-1 motion-safe:animate-[pulse_3s_ease-in-out_infinite]">
              <WandSparkles className="size-4 motion-safe:animate-spin" style={{ animationDuration: "3s" }} />
              <span className="text-xs font-medium">正在整理下一条灵感</span>
              <Check className="size-4 text-emerald-600 motion-safe:animate-bounce" />
            </Card>
          </div>
        </section>
        <section id="workflow" className="border-y border-neutral-200 bg-white">
          <div className="mx-auto max-w-7xl px-5 py-20 lg:px-8">
            <p className="text-xs font-medium uppercase text-neutral-500">
              一条自然的创作路径
            </p>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold sm:text-5xl">
              创作不必从空白开始
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                ["01", "描述", "把脑海里的画面说出来"],
                ["02", "探索", "让参考与灵感彼此回应"],
                ["03", "打磨", "在细节里完成最后一笔"],
              ].map(([n, k, t]) => (
                <Card
                  key={n}
                  className="group p-6 transition-colors hover:border-neutral-400"
                >
                  <div className={`flex items-center justify-between transition-transform duration-500 ${workflowStep === Number(n) - 1 ? "translate-x-1" : ""}`}>
                    <span className="text-xs font-medium text-neutral-500">
                      {n} / {k}
                    </span>
                    <Sparkles className={`size-5 text-neutral-400 transition-all duration-500 group-hover:text-neutral-950 ${workflowStep === Number(n) - 1 ? "rotate-12 scale-110 text-neutral-950" : ""}`} />
                  </div>
                  <h3 className="mt-14 text-xl font-semibold">{t}</h3>
                  <p className="mt-3 text-sm leading-6 text-neutral-600">
                    用一句话建立画面，再沿着结果继续。
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function ReferencePanel({ refs, setRefs, mode, setMode }) {
  const input = useRef(null);
  const add = async (files) => {
    const next = [];
    for (const f of [...files].slice(0, 4 - refs.length))
      if (/^image\/(png|jpeg|webp)$/.test(f.type))
        next.push({ data: await fileData(f), name: f.name });
    setRefs([...refs, ...next]);
  };
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          参考图片{" "}
          <span className="text-xs font-normal text-neutral-500">
            可选，最多 4 张
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => input.current?.click()}
        >
          <Upload className="size-4" />
          上传
        </Button>
        <input
          ref={input}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <div
        className="mt-3 grid min-h-24 grid-cols-4 gap-2 rounded-md border border-dashed border-neutral-300 p-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          add(e.dataTransfer.files);
        }}
      >
        {refs.length ? (
          refs.map((r, i) => (
            <div key={i} className="group relative overflow-hidden rounded">
              <img
                src={r.data}
                className="aspect-square w-full object-cover"
                alt={`参考图 ${i + 1}`}
              />
              <button
                className="absolute right-1 top-1 hidden rounded bg-white/90 p-1 group-hover:block"
                onClick={() => setRefs(refs.filter((_, n) => n !== i))}
                aria-label="删除参考图"
              >
                <X className="size-3" />
              </button>
            </div>
          ))
        ) : (
          <button
            className="col-span-4 grid place-items-center text-xs text-neutral-500"
            onClick={() => input.current?.click()}
          >
            <ImagePlus className="mb-1 size-5" />
            拖入图片，或点击上传
          </button>
        )}
      </div>
      {refs.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-neutral-100 p-1">
          {[
            ["reference", "参考构图"],
            ["blend", "融入主体"],
            ["edit", "修改原图"],
          ].map(([v, t]) => (
            <button
              key={v}
              className={`rounded px-2 py-1.5 text-xs transition-colors ${mode === v ? "bg-white font-medium shadow-sm" : "text-neutral-500"}`}
              onClick={() => setMode(v)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnotationEditor({ image, annotations, setAnnotations, onSubmit }) {
  const [tool, setTool] = useState("point");
  const [imageSize, setImageSize] = useState(null);
  const [drag, setDrag] = useState(null);
  const frame = useRef(null);
  const nextPoint = (event) => {
    const bounds = frame.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const updateNote = (id, note) =>
    setAnnotations((items) => items.map((item) => item.id === id ? { ...item, note } : item));
  const addMark = (mark) =>
    setAnnotations((items) => items.length >= 12 ? items : [...items, { ...mark, id: crypto.randomUUID(), note: "" }]);
  const finishBox = (event) => {
    if (!drag) return;
    const end = nextPoint(event);
    const box = {
      x: Math.min(drag.x, end.x),
      y: Math.min(drag.y, end.y),
      w: Math.abs(end.x - drag.x),
      h: Math.abs(end.y - drag.y),
    };
    setDrag(null);
    if (box.w > 0.008 && box.h > 0.008) addMark({ type: "area", ...box });
  };
  const marks = drag ? [...annotations, { ...drag, w: 0, h: 0, type: "draft" }] : annotations;
  return (
    <section className="mt-4 border-t border-neutral-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">标注修改位置</div>
          <p className="mt-1 text-xs text-neutral-500">点选位置或拖动框选，再填写该处的修改意见</p>
        </div>
        <div className="inline-flex rounded-md border border-neutral-200 p-1">
          <Button type="button" size="sm" variant={tool === "point" ? "secondary" : "ghost"} onClick={() => setTool("point")} aria-pressed={tool === "point"}>
            <MousePointer2 className="size-4" /> 点选
          </Button>
          <Button type="button" size="sm" variant={tool === "area" ? "secondary" : "ghost"} onClick={() => setTool("area")} aria-pressed={tool === "area"}>
            <Scan className="size-4" /> 框选
          </Button>
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 p-2">
        <div
          ref={frame}
          className={`relative mx-auto w-full max-w-full touch-none select-none overflow-hidden ${tool === "point" ? "cursor-crosshair" : "cursor-cell"}`}
          style={{
            aspectRatio: imageSize ? `${imageSize.width}/${imageSize.height}` : "1",
            maxWidth: imageSize ? `min(100%, ${Math.round(420 * imageSize.width / imageSize.height)}px)` : "100%",
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !imageSize) return;
            const point = nextPoint(event);
            if (tool === "point") addMark({ type: "point", ...point, w: 0, h: 0 });
            else {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag(point);
            }
          }}
          onPointerMove={(event) => {
            if (!drag) return;
            const point = nextPoint(event);
            setDrag((start) => ({ ...start, endX: point.x, endY: point.y }));
          }}
          onPointerUp={finishBox}
          onPointerCancel={() => setDrag(null)}
        >
          <img src={image} alt="待修改原图" className="absolute inset-0 size-full object-fill" draggable="false" onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {marks.map((mark, index) => {
            if (mark.type === "point") return (
              <span key={mark.id} className="absolute z-10 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-neutral-950 text-xs font-semibold text-white shadow" style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}>{index + 1}</span>
            );
            const x = mark.endX == null ? mark.x : Math.min(mark.x, mark.endX);
            const y = mark.endY == null ? mark.y : Math.min(mark.y, mark.endY);
            const w = mark.endX == null ? mark.w : Math.abs(mark.endX - mark.x);
            const h = mark.endY == null ? mark.h : Math.abs(mark.endY - mark.y);
            return <span key={mark.id} className="absolute z-10 border-2 border-neutral-950 bg-white/20" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}><span className="absolute -left-2 -top-3 grid size-6 place-items-center rounded-full bg-neutral-950 text-xs font-semibold text-white">{index + 1}</span></span>;
          })}
        </div>
      </div>
      {annotations.length > 0 && <div className="mt-3 space-y-2">
        {annotations.map((item, index) => (
          <div key={item.id} className="flex items-start gap-2 rounded-md border border-neutral-200 p-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-medium">{index + 1}</span>
            <textarea value={item.note} onChange={(event) => updateNote(item.id, event.target.value)} maxLength={500} rows="2" className="min-w-0 flex-1 resize-y border-0 bg-transparent p-1 text-sm outline-none placeholder:text-neutral-400" placeholder={item.type === "point" ? "这个位置要怎么修改？" : "框选区域要怎么修改？"} aria-label={`标注 ${index + 1} 的修改意见`} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setAnnotations((items) => items.filter((value) => value.id !== item.id))} aria-label={`删除标注 ${index + 1}`}><X className="size-4" /></Button>
          </div>
        ))}
      </div>}
      {annotations.length > 0 && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setAnnotations([])}>清除全部标注</Button>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">{annotations.length}/12 个标注</p>
        {onSubmit && <Button type="button" size="sm" disabled={!annotations.some((item) => item.note.trim())} onClick={() => onSubmit(annotations.filter((item) => item.note.trim()))}>
          <WandSparkles className="size-4" /> 按标注修改
        </Button>}
      </div>
    </section>
  );
}

function ResultCard({
  item,
  onDownload,
  onDelete,
  onEdit,
  onSave,
  favorite,
  onFavorite,
  onPreview,
}) {
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        className="block w-full cursor-zoom-in text-left"
        onClick={() => onPreview?.(item)}
        aria-label="放大查看图片"
      >
        <img
        src={item.image}
        alt="生成作品"
        loading="lazy"
        decoding="async"
        className="aspect-square w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
        />
      </button>
      <div className="flex items-center justify-between border-t border-neutral-200 p-3">
        <span className="text-xs text-neutral-500">
          {item.mode === "edit" ? "修改完成" : "生成完成"}
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFavorite?.(item)}
            aria-label={favorite ? "取消收藏" : "收藏作品"}
          >
            <Heart className={`size-4 ${favorite ? "fill-neutral-950" : ""}`} />
          </Button>
          {onEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(item)}
              aria-label="继续修改"
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
          {onSave && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSave(item)}
              aria-label="保存为模板"
            >
              <Plus className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDownload(item)}
            aria-label="下载作品"
          >
            <Download className="size-4" />
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(item)}
              aria-label="删除作品"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function ImageLightbox({ item, onClose, onEdit, onDownload }) {
  const [editing, setEditing] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  useEffect(() => {
    setEditing(false);
    setAnnotations([]);
  }, [item?.image]);
  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-neutral-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <div className="relative flex max-h-[92vh] max-w-[94vw] flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <span className="truncate pr-4 text-sm font-medium">{editing ? "标注修改位置" : (item.title || "图片预览")}</span>
          <div className="flex items-center gap-1">
            {!editing && onEdit && <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Scan className="size-4" /> 标注修改</Button>}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭预览"><X className="size-4" /></Button>
          </div>
        </div>
        <div className="min-h-0 overflow-auto bg-neutral-100 p-3">
          {editing ? <AnnotationEditor image={item.image} annotations={annotations} setAnnotations={setAnnotations} onSubmit={(marks) => { onEdit({ ...item, annotations: marks }); setEditing(false); }} /> : <img src={item.image} alt={item.title || "图片预览"} className="mx-auto max-h-[72vh] max-w-full object-contain" />}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => onDownload(item)}><Download className="size-4" /> 下载</Button>
          {onEdit && !editing && <Button size="sm" onClick={() => onEdit(item)}><WandSparkles className="size-4" /> 继续修改</Button>}
        </div>
      </div>
    </div>
  );
}

function Studio({ quota, leave, templates, refreshQuota, activeJob, activeVideo }) {
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState("");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [mode, setMode] = useState("reference");
  const [refs, setRefs] = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const [editBasePrompt, setEditBasePrompt] = useState("");
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState([]);
  const [history, setHistory] = useState([]);
  const tab = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("view") || "create";
  const changeTab = (next) => {
    const url = new URL(window.location.href);
    if (next === "create") url.searchParams.delete("view"); else url.searchParams.set("view", next);
    window.location.href = `${url.pathname}${url.search}${url.hash}`;
  };
  const [videoRecords, setVideoRecords] = useState([]);
  const [videoJob, setVideoJob] = useState(null);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoImage, setVideoImage] = useState(null);
  const [videoSeconds, setVideoSeconds] = useState(5);
  const [videoRatio, setVideoRatio] = useState("16:9");
  const [videoResolution, setVideoResolution] = useState("768P");
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoError, setVideoError] = useState("");
  useEffect(()=>{if(activeVideo)setVideoJob(activeVideo);},[activeVideo?.id]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("jianlai-favorites") || "[]");
    } catch {
      return [];
    }
  });
  const [lightbox, setLightbox] = useState(null);
  const [mineTemplates, setMineTemplates] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem("jianlai-private-templates") || "[]",
      );
    } catch {
      return [];
    }
  });
  const loadHistory = () =>
    api("history?limit=100")
      .then((v) => setHistory(v.records || []))
      .catch(() => {});
  const loadVideos = () => api("videos").then((v) => setVideoRecords(v.records || [])).catch(() => {});
  useEffect(() => { loadVideos(); }, []);
  useEffect(() => {
    if (tab !== "video" || !videoJob || ["done", "failed"].includes(videoJob.status)) return;
    let cancelled=false;
    const poll=async()=>{
      while(!cancelled){
        try {
          const next=await api(`videos/${videoJob.id}`);
          if(["done","failed"].includes(next.status)){
            if(!cancelled){setVideoJob(next);setVideoBusy(false);setVideoError(next.status==="failed"?next.error:"");loadVideos();refreshQuota(next.availableCents);}
            break;
          }
          if(!cancelled)setVideoJob(next);
        }catch{if(!cancelled)setVideoError("状态暂时无法读取，任务仍会在服务端继续；稍后再试");}
        await new Promise(r=>setTimeout(r,10000));
      }
    };
    poll();
    return()=>{cancelled=true;};
  },[tab,videoJob?.id,videoJob?.status]);
  useEffect(() => {
    loadHistory();
  }, []);
  useEffect(() => {
    if (!activeJob || ["done", "failed"].includes(activeJob.status)) return;
    let cancelled = false;
    const resume = async () => {
      setBusy(true);
      setMessage("正在恢复生成任务…");
      let current = activeJob;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (
        !cancelled &&
        Date.now() < deadline &&
        !["done", "failed"].includes(current.status)
      ) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          current = await api(`jobs/${activeJob.id}`);
        } catch {
          if (!cancelled) setMessage("网络暂时中断，正在恢复任务状态…");
        }
      }
      if (cancelled) return;
      if (current.status === "done") {
        setResults(
          (current.images || []).map((item) => ({
            ...item,
            jobId: current.id,
            image: assetUrl(item.previewUrl || item.url),
            downloadUrl: assetUrl(item.downloadUrl || item.url),
            mode: current.params?.mode || "reference",
            prompt: current.params?.prompt || "",
            created: current.created,
          })),
        );
        setMessage(`完成 · ${(current.images || []).length} 张`);
        loadHistory();
      } else if (current.status === "failed")
        setMessage(current.error || "生成失败");
      else setMessage("任务状态暂未确认，请刷新页面或在作品中查看。");
      setBusy(false);
      refreshQuota();
    };
    resume();
    return () => {
      cancelled = true;
    };
  }, [activeJob?.id]);
  const download = (item) => {
    const a = document.createElement("a");
    a.href = item.downloadUrl || item.image || `../${String(item.url || "").replace(/^\//, "")}`;
    a.download = `jianlai-${item.id || Date.now()}.png`;
    a.click();
  };
  const generate = async () => {
    const validNotes = annotations.filter((item) => item.note.trim());
    const hasEditInstructions = prompt.trim() || validNotes.length;
    if ((!hasEditInstructions && refs.length && mode === "edit") || (!prompt.trim() && !(refs.length && mode === "edit")) || busy || quota === 0) return;
    const submittedPrompt = refs.length && mode === "edit"
      ? [editBasePrompt && `原图创作方向：${editBasePrompt}`, prompt.trim() && `整体修改意见：${prompt.trim()}`].filter(Boolean).join("\n") || "请根据标注意见修改原图"
      : prompt.trim();
    setBusy(true);
    setMessage("正在准备画面…");
    setResults([]);
    try {
      const job = await api("generate", {
        method: "POST",
        body: JSON.stringify({
          prompt: submittedPrompt,
          text,
          references: refs.map((r) => r.data),
          annotations: mode === "edit" ? validNotes.map((item) => ({
            type: item.type === "area" ? "box" : "point",
            x: item.x,
            y: item.y,
            ...(item.type === "area" ? { w: item.w, h: item.h } : {}),
            text: item.note.trim(),
          })) : [],
          mode: refs.length ? mode : "reference",
          compare: compare && !refs.length,
          count: compare && !refs.length ? 2 : 1,
          size,
          quality,
          requestKey: crypto.randomUUID(),
        }),
      });
      let current = job;
      setMessage("画面生成中…");
      for (
        let i = 0;
        i < 150 && !["done", "failed"].includes(current.status);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        current = await api(`jobs/${job.id}`);
      }
      if (current.status !== "done")
        throw new Error(current.error || "生成失败");
      const next = (current.images || []).map((i) => ({
        ...i,
        jobId: current.id,
        image: assetUrl(i.previewUrl || i.url),
        downloadUrl: assetUrl(i.downloadUrl || i.url),
        mode,
        prompt: submittedPrompt,
        created: current.created,
      }));
      setResults(next);
      setMessage(`完成 · ${next.length} 张`);
      refreshQuota(current.availableCents);
      loadHistory();
    } catch (e) {
      setMessage(e.message || "生成失败");
    } finally {
      setBusy(false);
      refreshQuota();
    }
  };
  const toggleFavorite = (item) =>
    setFavorites((previous) => {
      const id = item.image;
      const next = previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id];
      localStorage.setItem("jianlai-favorites", JSON.stringify(next));
      return next;
    });
  const continueEdit = async (item) => {
    try {
      // Prefer the OSS original URL. The API proxy is only a compatibility
      // fallback for legacy rows that have no object URL yet.
      const source = item.downloadUrl || item.image || (item.jobId && item.index != null
        ? `${base}api/jobs/${item.jobId}/images/${item.index}`
        : "");
      const response = await fetch(source, { credentials: "same-origin" });
      if (!response.ok) throw new Error("无法读取原图");
      const data = await fileData(await response.blob());
      setRefs([{ data, name: "作品" }]);
    setEditBasePrompt(item.prompt || "");
    setAnnotations(item.annotations || []);
    setMode("edit");
    setPrompt("");
    changeTab("create");
    setMessage("已带入原图，可以继续描述修改内容");
    } catch { setMessage("无法读取原图，请重新上传图片"); }
  };
  const saveTemplate = (item) => {
    const title = window.prompt(
      "给私人模板起个名字",
      (item.prompt || "我的创作").slice(0, 20),
    );
    if (!title?.trim()) return;
    const next = [
      {
        id: `private-${Date.now()}`,
        title: title.trim(),
        prompt: item.prompt || "",
        text: item.text || "",
        image: item.downloadUrl || item.image,
        preview: item.image,
        private: true,
        category: "mine",
      },
      ...mineTemplates,
    ];
    setMineTemplates(next);
    localStorage.setItem("jianlai-private-templates", JSON.stringify(next));
    setMessage("已保存到私人模板");
  };
  const visibleTemplates = useMemo(
    () =>
      [
        ...mineTemplates,
        ...(templates.length
          ? templates
          : fallbackWorks.map(([preview, title]) => ({ preview, title }))),
      ]
        .filter(
          (t) =>
            filter === "all" ||
            t.category === filter ||
            (filter === "mine" && t.private),
        )
        .filter(
          (t) =>
            !search ||
            `${t.title} ${t.description || ""} ${(t.tags || []).join(" ")}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        ),
    [templates, mineTemplates, filter, search],
  );
  const templateCategories = useMemo(
    () => [...new Set([...mineTemplates.map(() => "mine"), ...templates.map((t) => t.category).filter(Boolean)])],
    [templates, mineTemplates],
  );
  const applyTemplate = (t) => {
    const defaults = t.parameterDefaults || {};
    const nextPrompt = String(
      t.prompt || t.description || t.title || "",
    ).replace(
      /\{\{([^}]+)\}\}/g,
      (_, key) => defaults[key.trim()] || key.trim(),
    );
    setPrompt(nextPrompt);
    setText(
      String(t.text || "").replace(
        /\{\{([^}]+)\}\}/g,
        (_, key) => defaults[key.trim()] || key.trim(),
      ),
    );
    if (t.size) setSize(t.size);
    changeTab("create");
  };
  return (
    <div className="studio-shell min-h-screen text-neutral-950">
      <header className="studio-titlebar">
        <div className="studio-window-controls" aria-label="窗口控制装饰">
          <span className="studio-window-dot studio-window-dot-close" />
          <span className="studio-window-dot studio-window-dot-minimize" />
          <span className="studio-window-dot studio-window-dot-expand" />
        </div>
        <div className="studio-titlebar-brand">
          <span className="studio-brand-mark"><Sparkles className="size-3.5" /></span>
          <span>剑来华东 · 生图工作站</span>
        </div>
        <div className="studio-titlebar-actions">
          <span className="studio-quota">{quota == null ? "余额读取中" : `余额 ¥${(quota / 100).toFixed(2)}`}</span>
          <button className="studio-home-button" onClick={leave} aria-label="返回首页" title="返回首页">
            <ArrowLeft className="size-4" />
          </button>
        </div>
      </header>
      <main className="studio-main mx-auto max-w-7xl px-5 py-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-neutral-500">创作空间</p>
            <h1 className="mt-1 text-2xl font-semibold">生图工作台</h1>
          </div>
        </div>
        <div className="studio-tabs mt-5 flex gap-1" role="tablist" aria-label="工作区" onKeyDown={event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();const tabs=["video","create","history","templates"];const current=tabs.indexOf(tab);const next=event.key==="Home"?tabs[0]:event.key==="End"?tabs.at(-1):tabs[(current+(event.key==="ArrowRight"?1:tabs.length-1))%tabs.length];changeTab(next);event.currentTarget.querySelector(`[data-view="${next}"]`)?.focus();}}>
          <button type="button" data-view="video" className={`studio-tab ${tab === "video" ? "is-active" : ""}`} role="tab" aria-selected={tab === "video"} tabIndex={tab==="video"?0:-1} onClick={() => { changeTab("video");loadVideos();if(!videoJob)api("bootstrap").then(v=>v.activeVideo&&setVideoJob(v.activeVideo)).catch(()=>{}); }}>
            <Film className="size-4" />
            视频
          </button>
          <button type="button" data-view="create" className={`studio-tab ${tab === "create" ? "is-active" : ""}`} role="tab" aria-selected={tab === "create"} tabIndex={tab==="create"?0:-1} onClick={() => changeTab("create")}>
            <WandSparkles className="size-4" />
            创作
          </button>
          <button type="button" data-view="history" className={`studio-tab ${tab === "history" ? "is-active" : ""}`} role="tab" aria-selected={tab === "history"} tabIndex={tab==="history"?0:-1} onClick={() => {changeTab("history");loadHistory();}}>
            <Images className="size-4" />
            作品历史
          </button>
          <button type="button" data-view="templates" className={`studio-tab ${tab === "templates" ? "is-active" : ""}`} role="tab" aria-selected={tab === "templates"} tabIndex={tab==="templates"?0:-1} onClick={() => changeTab("templates")}>
            <Sparkles className="size-4" />
            灵感模板
          </button>
        </div>
        {tab === "video" && <VideoStudio {...{quota,videoRecords,videoJob,videoPrompt,setVideoPrompt,videoImage,setVideoImage,videoSeconds,setVideoSeconds,videoRatio,setVideoRatio,videoResolution,setVideoResolution,videoBusy,setVideoBusy,videoError,setVideoError,setVideoJob,refreshQuota,loadVideos}} />}
        {tab === "create" && (
          <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <WandSparkles className="size-4" />
                描述画面
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={mode === "edit" && refs.length ? "输入整体修改意见；也可以只填写下方标注意见" : "例如：雨后的上海街头，一家有暖黄色灯光的咖啡店，电影感，竖版海报"}
                className="mt-4 min-h-36 w-full resize-y rounded-md border border-neutral-200 bg-white p-4 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-950 focus:ring-2 focus:ring-neutral-950/10"
              />
              <div className="mt-3">
                <label className="text-xs text-neutral-500">
                  画面文字 <span>可选</span>
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows="2"
                  placeholder="需要出现在画面中的文字"
                  className="mt-1 w-full resize-y rounded-md border border-neutral-200 p-3 text-sm outline-none focus:border-neutral-950"
                />
              </div>
              <ReferencePanel {...{ refs, setRefs, mode, setMode }} />
              {mode === "edit" && refs[0] && <AnnotationEditor image={refs[0].data} annotations={annotations} setAnnotations={setAnnotations} />}
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-neutral-500">
                  画幅
                  <select
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    className="mt-1 block h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm"
                  >
                    <option value="auto">自动画幅</option>
                    <option value="1024x1024">1:1 · 方形</option>
                    <option value="1536x1024">3:2 · 横版</option>
                    <option value="1024x1536">2:3 · 竖版</option>
                    <option value="1536x864">16:9 · 横屏</option>
                    <option value="864x1536">9:16 · 手机竖屏</option>
                    <option value="1365x1024">4:3 · 横版</option>
                    <option value="1024x1365">3:4 · 竖版</option>
                    <option value="864x1872">9:19.5 · 手机长屏</option>
                  </select>
                </label>
                <label className="text-xs text-neutral-500">
                  质量
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value)}
                    className="mt-1 block h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm"
                  >
                    <option value="auto">自动质量</option>
                    <option value="low">标准</option>
                    <option value="medium">精细</option>
                    <option value="high">高质量</option>
                  </select>
                </label>
              </div>
              <label
                className={`mt-4 flex items-center gap-2 text-sm ${refs.length ? "text-neutral-400" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={compare}
                  disabled={!!refs.length}
                  onChange={(e) => setCompare(e.target.checked)}
                />
                生成对比方案（2 张）
              </label>
              <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-200 pt-4">
                <span className="text-xs text-neutral-500" aria-live="polite">
                  {message || "每张图片 ¥0.30，失败不扣费"}
                </span>
                <Button
                  onClick={generate}
                  disabled={busy || (!prompt.trim() && !(refs.length > 0 && mode === "edit" && annotations.some((item) => item.note.trim()))) || quota === 0}
                >
                  {busy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      生成中
                    </>
                  ) : (
                    <>
                      <Send className="size-4" />
                      生成画面
                    </>
                  )}
                </Button>
              </div>
            </Card>
            <Card className="min-h-[28rem] p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Images className="size-4" />
                  本次结果
                </div>
                {results.length > 0 && <Badge>{results.length} 张</Badge>}
              </div>
              {busy && (
                <div className="grid min-h-[24rem] place-items-center text-center text-sm text-neutral-500">
                  <Loader2 className="mx-auto size-7 animate-spin" />
                  <p className="mt-3">正在生成你的画面</p>
                  <p className="text-xs">可以继续准备下一次灵感</p>
                </div>
              )}
              {!busy && !results.length && (
                <div className="grid min-h-[24rem] place-items-center text-center text-sm text-neutral-500">
                  <FileImage className="mx-auto size-8" />
                  <p className="mt-3">生成结果会出现在这里</p>
                  <p className="mt-1 text-xs">
                    先写下一句描述，工作站会保留你的创作线索。
                  </p>
                </div>
              )}
              {!busy && results.length > 0 && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {results.map((item, i) => (
                    <ResultCard key={i} item={item} onDownload={download} onEdit={continueEdit} onSave={saveTemplate} onPreview={setLightbox} favorite={favorites.includes(item.image)} onFavorite={toggleFavorite} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
        {tab === "history" && (
          <section className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">我的作品</h2>
                <p className="mt-1 text-sm text-neutral-500">
                  作品保留 7 天，请及时下载保存。
                </p>
              </div>
              <div className="relative">
                <Clock3 className="absolute left-3 top-2.5 size-4 text-neutral-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索提示词"
                  className="h-9 rounded-md border border-neutral-200 bg-white pl-9 pr-3 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {history
                .filter(
                  (i) =>
                    !search ||
                    i.prompt?.toLowerCase().includes(search.toLowerCase()),
                )
                .map((item) => (
                  <ResultCard
                    key={item.id}
                    item={{ ...item, image: assetUrl(item.previewUrl || item.image), downloadUrl: assetUrl(item.downloadUrl || item.image) }}
                    onDownload={download}
                    onEdit={continueEdit}
                    onSave={saveTemplate}
                    onPreview={setLightbox}
                    favorite={favorites.includes(assetUrl(item.image))}
                    onFavorite={toggleFavorite}
                    onDelete={async (x) => {
                      if (x.jobId)
                        await api(`jobs/${x.jobId}/images/${x.index}`, {
                          method: "DELETE",
                        });
                      loadHistory();
                    }}
                  />
                ))}
            </div>
            {!history.length && (
              <div className="border border-dashed border-neutral-300 py-20 text-center text-sm text-neutral-500">
                还没有作品，开始第一次创作吧。
              </div>
            )}
          </section>
        )}
        {tab === "templates" && (
          <section className="mt-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">灵感模板</h2>
                <p className="mt-1 text-sm text-neutral-500">
                  从一个方向开始，再带着它继续创作。
                </p>
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模板"
                className="h-9 rounded-md border border-neutral-200 bg-white px-3 text-sm"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {["all", ...templateCategories].map((v) => (
                <Button
                  key={v}
                  variant={filter === v ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(v)}
                >
                  {{all: "全部", mine: "我的模板", fun: "人像趣味", policy: "销售政策", reward: "销售奖励", ranking: "排行榜", poster: "销售海报", comic: "漫画分镜", infographic: "销售图表", social: "营销社媒"}[v] || v}
                </Button>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {visibleTemplates.map((t, i) => (
                <div
                  key={t.id || i}
                  className="group overflow-hidden rounded-lg border border-neutral-200 bg-white text-left"
                  role="button"
                  tabIndex={0}
                  onClick={() => applyTemplate(t)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") applyTemplate(t); }}
                >
                  <img
                    src={assetUrl(
                      t.preview || fallbackWorks[i % fallbackWorks.length][0],
                    )}
                    alt={t.title || "模板"}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLightbox({ image: assetUrl(t.preview || fallbackWorks[i % fallbackWorks.length][0]), title: t.title || "模板预览", prompt: t.prompt || t.description || t.title || "", text: t.text || "", isTemplate: true });
                    }}
                  />
                  <span className="block truncate px-3 py-2 text-xs text-neutral-600">
                    {t.title || "灵感模板"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
      <ImageLightbox
        item={lightbox}
        onClose={() => setLightbox(null)}
        onDownload={download}
        onEdit={(item) => {
          setLightbox(null);
          if (item.isTemplate) {
            setPrompt(item.prompt || "");
            setText(item.text || "");
            changeTab("create");
            setMessage("已带入模板描述，可以继续调整后生成");
          } else continueEdit(item);
        }}
      />
    </div>
  );
}

export function VideoStudio({quota,videoRecords,videoJob,videoPrompt,setVideoPrompt,videoImage,setVideoImage,videoSeconds,setVideoSeconds,videoRatio,setVideoRatio,videoResolution,setVideoResolution,videoBusy,setVideoBusy,videoError,setVideoError,setVideoJob,refreshQuota,loadVideos}) {
  const [mode,setMode]=useState("text");
  const [preview,setPreview]=useState("");
  const cost=videoSeconds*120;
  const current=videoJob&&["queued","running"].includes(videoJob.status)?videoJob:null;
  const pick=async file=>{
    if(!file)return;
    if(!["image/png","image/jpeg","image/webp"].includes(file.type)){setVideoError("首帧请使用 PNG、JPG 或 WebP 图片");return;}
    if(file.size>20*1024*1024){setVideoError("图片不能超过 20 MB");return;}
    const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
    const img=new Image();img.onload=()=>{if(img.naturalWidth<256||img.naturalHeight<256){setVideoError("图片宽高至少需要 256 像素");return;}setVideoError("");setVideoImage(data);setPreview(URL.createObjectURL(file));};img.onerror=()=>setVideoError("无法读取这张图片");img.src=data;
  };
  const submit=async()=>{
    if(current||!videoPrompt.trim()||videoPrompt.length>2000||videoBusy)return;
    if(mode==="image"&&!videoImage){setVideoError("请先上传首帧图片");return;}
    if(quota!=null&&quota<cost){setVideoError(`余额不足：${videoSeconds} 秒视频预计 ¥${(cost/100).toFixed(2)}`);return;}
    setVideoBusy(true);setVideoError("");
    const requestKey=crypto.randomUUID().replaceAll("_", "-");
    try{
      const job=await api("videos",{method:"POST",body:JSON.stringify({requestKey,prompt:videoPrompt.trim(),duration:videoSeconds,ratio:videoRatio,resolution:videoResolution,image:mode==="image"?videoImage:""})});
      setVideoJob(job);refreshQuota(job.availableCents);setVideoError("");
    }catch(e){setVideoError(e.message||"视频任务提交失败");setVideoBusy(false);refreshQuota();}
  };
  const download=(url,id)=>{const a=document.createElement("a");a.href=url;a.download=`jianlai-video-${id}.mp4`;a.target="_blank";a.rel="noopener";a.click();};
  return <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.72fr)]">
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">创建视频</h2><p className="mt-1 text-sm text-neutral-500">文生视频或用首帧图片驱动</p></div><Badge><Film className="mr-1.5 size-3.5"/>¥1.20 / 秒</Badge></div>
      <div className="mt-5 inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-1" role="tablist" aria-label="视频生成模式">
        {[ ["text","文字生成"],["image","图片生成"] ].map(([value,label])=><button key={value} type="button" role="tab" aria-selected={mode===value} onClick={()=>{setMode(value);if(value==="text"&&videoResolution==="2K")setVideoResolution("768P");setVideoError("");}} className={`rounded px-3 py-2 text-sm transition-colors ${mode===value?"bg-neutral-950 text-white":"text-neutral-600 hover:bg-white"}`}>{label}</button>)}
      </div>
      {mode==="image"&&<div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_1.2fr]">
        <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-4 text-center text-sm text-neutral-600 hover:border-neutral-500">
          {preview?<img src={preview} alt="视频首帧" className="max-h-44 max-w-full rounded object-contain"/>:<><ImagePlus className="size-5"/><span>上传首帧图片</span><span className="text-xs text-neutral-400">PNG / JPG / WebP，最大 20 MB</span></>}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={e=>pick(e.target.files?.[0])}/>
        </label><div className="flex items-center"><p className="text-sm leading-6 text-neutral-600">视频将从首帧开始延展。主体、动作方向、镜头运动和环境变化写进描述，会帮助生成结果更稳定。</p></div>
      </div>}
      <label className="mt-5 block text-sm font-medium">描述画面</label>
      <textarea value={videoPrompt} onChange={e=>setVideoPrompt(e.target.value)} maxLength={2000} placeholder="例如：镜头缓慢推近，窗边咖啡杯升起细微热气，雨滴沿玻璃滑落，暖色电影光线，动作自然连贯" className="mt-2 min-h-32 w-full resize-y rounded-md border border-neutral-200 bg-white p-3 text-sm leading-6 outline-none placeholder:text-neutral-400 focus:border-neutral-800 focus:ring-2 focus:ring-neutral-900/10"/>
      <div className="mt-1 flex justify-end text-xs text-neutral-400">{videoPrompt.length}/2000</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label="时长" value={String(videoSeconds)} onChange={v=>setVideoSeconds(Number(v))} items={Array.from({length:12},(_,i)=>({id:String(i+4),label:`${i+4} 秒`}))}/>
        <SelectField label={mode==="image"?"画幅 · 跟随首帧":"画幅"} disabled={mode==="image"} value={videoRatio} onChange={setVideoRatio} items={[["16:9","横屏"],["9:16","竖屏"],["1:1","方形"],["4:3","横版"],["3:4","竖版"],["21:9","宽银幕"]].map(([id,label])=>({id,label:`${id} · ${label}`}))}/>
        <SelectField label="分辨率" value={videoResolution} onChange={setVideoResolution} items={[{id:'768P',label:'768P'},...(mode==="image"?[{id:'2K',label:'2K'}]:[])]}/>
      </div>
      <div className="mt-5 flex flex-col gap-4 border-t border-neutral-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div><div className="text-sm font-medium">预计费用 ¥{(cost/100).toFixed(2)}</div><div className="mt-1 text-xs leading-5 text-neutral-500">预计生成约 {videoSeconds} 分钟，实际时间受上游排队影响。失败会自动退回余额。</div></div>
        <Button onClick={submit} disabled={videoBusy||!!current||!videoPrompt.trim()||(mode==="image"&&!videoImage)}><Film className="size-4"/>{current?"生成中":"生成视频"}</Button>
      </div>
      {videoError&&<p role="alert" className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{videoError}</p>}
    </Card>
    <div className="space-y-6">
      {current&&<Card className="p-5" aria-live="polite">
        <div className="flex items-center justify-between gap-3"><div className="text-sm font-semibold">{current.phase==="submitting"?"正在提交任务":"正在生成"}</div><div className="font-mono text-sm tabular-nums">{current.progress||0}%</div></div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-emerald-600 transition-[width] duration-700" style={{width:`${Math.min(95,current.progress||1)}%`}}/></div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500"><span>已等待 {Math.floor((current.elapsedSeconds||0)/60)} 分 {(current.elapsedSeconds||0)%60} 秒</span><span>预计约 {current.estimatedSeconds?Math.round(current.estimatedSeconds/60):current.duration} 分钟</span></div>
        <p className="mt-4 text-sm leading-6 text-neutral-600">任务正在幻灵 AI 排队与生成。页面可以离开，回来后会继续显示进度。</p>
        <p className="mt-3 line-clamp-3 border-t border-neutral-100 pt-3 text-xs leading-5 text-neutral-500">{current.prompt}</p>
      </Card>}
      {!current&&videoJob?.status==="done"&&videoJob.url&&<Card className="overflow-hidden"><video src={videoJob.url} controls playsInline preload="metadata" className="aspect-video w-full bg-neutral-950"/><div className="flex items-center justify-between gap-3 p-4"><div><div className="text-sm font-medium">生成完成 · {videoJob.duration} 秒</div><div className="mt-1 text-xs text-neutral-500">已扣 ¥{(videoJob.chargedCents/100).toFixed(2)}</div></div><Button size="sm" onClick={()=>download(videoJob.url,videoJob.id)}><Download className="size-4"/>下载视频</Button></div></Card>}
      <section><div className="flex items-end justify-between gap-3"><div><h3 className="text-base font-semibold">最近视频</h3><p className="mt-1 text-xs text-neutral-500">视频保留 7 天</p></div><button type="button" onClick={loadVideos} className="text-xs text-neutral-500 underline underline-offset-4">刷新</button></div>
        <div className="mt-3 space-y-3">{videoRecords.filter(v=>v.status==="done"&&v.url).map(v=><Card key={v.id} className="overflow-hidden"><video src={v.url} controls playsInline preload="none" className="aspect-video w-full bg-neutral-950"/><div className="flex items-center justify-between gap-3 p-3"><div className="min-w-0"><div className="text-xs font-medium">{v.duration} 秒 · {v.ratio}</div><p className="mt-1 line-clamp-2 text-xs text-neutral-500">{v.prompt}</p></div><Button variant="ghost" size="sm" aria-label="下载视频" onClick={()=>download(v.url,v.id)}><Download className="size-4"/></Button></div></Card>)}
          {videoRecords.some(v=>v.status==="failed")&&videoRecords.filter(v=>v.status==="failed").slice(0,2).map(v=><div key={v.id} className="flex items-start gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs text-neutral-500"><span className="mt-0.5 size-2 shrink-0 rounded-full bg-rose-500"/><span>{v.error||"视频任务失败，额度已退回"}</span></div>)}
          {!videoRecords.length&&<div className="rounded-md border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500">完成的视频会保存在这里</div>}
        </div>
      </section>
    </div>
  </section>;
}

export function WorkbenchApp() {
  // The creator is the primary product surface; the introduction remains available via the home button.
  const [view, setView] = useState("studio");
  const [quota, setQuota] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [activeVideo, setActiveVideo] = useState(null);
  const [mobile, setMobile] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const refresh = (knownQuota) =>
    api("bootstrap")
      .then((v) => {
        const cents = Number(v.availableCents);
        setQuota(knownQuota != null && Number.isFinite(Number(knownQuota)) ? Number(knownQuota) : Number.isFinite(cents) ? cents : null);
        setActiveJob((previous) =>
          previous?.id === v.activeJob?.id ? previous : v.activeJob,
        );
        setActiveVideo((previous)=>previous?.id===v.activeVideo?.id?previous:v.activeVideo);
      })
      .catch(() => {});
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (view !== "studio" || templatesLoaded) return;
    let cancelled = false;
    const load = () => api("templates").then((v) => {
      if (!cancelled) { setTemplates(v.templates || []); setTemplatesLoaded(true); }
    }).catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(load, { timeout: 1200 });
      return () => { cancelled = true; window.cancelIdleCallback?.(id); };
    }
    const id = window.setTimeout(load, 120);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [view, templatesLoaded]);
  useEffect(() => {
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, []);
  return view === "studio" ? (
    <Studio
      {...{ quota, templates, activeJob, activeVideo, refreshQuota: refresh }}
      leave={() => {
        setView("landing");
        setMobile(false);
      }}
    />
  ) : (
    <Landing
      {...{ quota, mobile, setMobile }}
      enter={() => {
        setView("studio");
        setMobile(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }}
    />
  );
}
