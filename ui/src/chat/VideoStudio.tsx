import { useEffect, useState } from 'react'
import { Download, Film, ImagePlus } from 'lucide-react'
import { SelectField } from '../components/ui/select'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card } from '../components/ui/card'
import type { VideoJob } from './api'
import type { VideoPayload } from './video-pending'
import type { VideoFormValues } from './schemas'

type StudioVideoJob = VideoJob & {
  progress?: number
  elapsedSeconds?: number
  estimatedSeconds?: number
}

type Props = {
  quota: number | null
  videoRecords: StudioVideoJob[]
  videoJob: StudioVideoJob | null
  videoPrompt: string
  setVideoPrompt: (value: string) => void
  videoImage: string | null
  setVideoImage: (value: string | null) => void
  videoSeconds: number
  setVideoSeconds: (value: number) => void
  videoRatio: VideoFormValues['ratio']
  setVideoRatio: (value: string) => void
  videoResolution: VideoFormValues['resolution']
  setVideoResolution: (value: string) => void
  videoBusy: boolean
  videoError: string
  setVideoError: (value: string) => void
  submitVideo: (payload: VideoPayload) => Promise<void>
  pendingVideo: boolean
  checkPendingVideo: () => Promise<void>
  loadVideos: () => void
}

/** Video UI kept separate from the single image workbench entry. */
export function VideoStudio({quota,videoRecords,videoJob,videoPrompt,setVideoPrompt,videoImage,setVideoImage,videoSeconds,setVideoSeconds,videoRatio,setVideoRatio,videoResolution,setVideoResolution,videoBusy,videoError,setVideoError,submitVideo,pendingVideo,checkPendingVideo,loadVideos}: Props) {
  const [mode,setMode]=useState("text");
  const [preview,setPreview]=useState("");
  const cost=videoSeconds*120;
  const current=videoJob&&["queued","running"].includes(videoJob.status)?videoJob:null;
  useEffect(() => () => { if (preview.startsWith('blob:')) URL.revokeObjectURL(preview) }, [preview]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setVideoError("首帧请使用 PNG、JPG 或 WebP 图片"); return; }
    if (file.size > 20 * 1024 * 1024) { setVideoError("图片不能超过 20 MB"); return; }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取这张图片'));
        reader.onerror = () => reject(reader.error || new Error('无法读取这张图片'));
        reader.readAsDataURL(file);
      });
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('无法读取这张图片'));
        image.src = data;
      });
      if (image.naturalWidth < 256 || image.naturalHeight < 256) { setVideoError("图片宽高至少需要 256 像素"); return; }
      setVideoError("");
      setVideoImage(data);
      setPreview(URL.createObjectURL(file));
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : '无法读取这张图片');
    }
  };
  const submit=async()=>{
    if(current||!videoPrompt.trim()||videoPrompt.length>2000||videoBusy)return;
    if(mode==="image"&&!videoImage){setVideoError("请先上传首帧图片");return;}
    if(!pendingVideo&&quota!=null&&quota<cost){setVideoError(`余额不足：${videoSeconds} 秒视频预计 ¥${(cost/100).toFixed(2)}`);return;}
    await submitVideo({prompt:videoPrompt.trim(),duration:videoSeconds,ratio:videoRatio,resolution:videoResolution,image:mode==="image"?videoImage || "":""});
  };
  const download=(url: string,id: string)=>{const a=document.createElement("a");a.href=url;a.download=`jianlai-video-${id}.mp4`;a.target="_blank";a.rel="noopener";a.click();};
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
      <textarea aria-label="描述画面" value={videoPrompt} onChange={e=>setVideoPrompt(e.target.value)} maxLength={2000} placeholder="例如：镜头缓慢推近，窗边咖啡杯升起细微热气，雨滴沿玻璃滑落，暖色电影光线，动作自然连贯" className="mt-2 min-h-32 w-full resize-y rounded-md border border-neutral-200 bg-white p-3 text-sm leading-6 outline-none placeholder:text-neutral-400 focus:border-neutral-800 focus:ring-2 focus:ring-neutral-900/10"/>
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
      {pendingVideo&&<Button variant="outline" className="mt-4" onClick={()=>void checkPendingVideo()} disabled={videoBusy}>核对上次提交</Button>}
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
      {!current&&videoJob?.status==="done"&&videoJob.url&&<Card className="overflow-hidden"><video src={videoJob.url} controls playsInline preload="metadata" className="aspect-video w-full bg-neutral-950"/><div className="flex items-center justify-between gap-3 p-4"><div><div className="text-sm font-medium">生成完成 · {videoJob.duration} 秒</div><div className="mt-1 text-xs text-neutral-500">已扣 ¥{((videoJob.chargedCents || 0)/100).toFixed(2)}</div></div><Button size="sm" onClick={()=>download(videoJob.url!,videoJob.id)}><Download className="size-4"/>下载视频</Button></div></Card>}
      <section><div className="flex items-end justify-between gap-3"><div><h3 className="text-base font-semibold">最近视频</h3><p className="mt-1 text-xs text-neutral-500">视频保留 7 天</p></div><button type="button" onClick={loadVideos} className="text-xs text-neutral-500 underline underline-offset-4">刷新</button></div>
        <div className="mt-3 space-y-3">{videoRecords.filter(v=>v.status==="done"&&v.url).map(v=><Card key={v.id} className="overflow-hidden"><video src={v.url || undefined} controls playsInline preload="none" className="aspect-video w-full bg-neutral-950"/><div className="flex items-center justify-between gap-3 p-3"><div className="min-w-0"><div className="text-xs font-medium">{v.duration} 秒 · {v.ratio}</div><p className="mt-1 line-clamp-2 text-xs text-neutral-500">{v.prompt}</p></div><Button variant="ghost" size="sm" aria-label="下载视频" onClick={()=>download(v.url!,v.id)}><Download className="size-4"/></Button></div></Card>)}
          {videoRecords.some(v=>v.status==="failed")&&videoRecords.filter(v=>v.status==="failed").slice(0,2).map(v=><div key={v.id} className="flex items-start gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs text-neutral-500"><span className="mt-0.5 size-2 shrink-0 rounded-full bg-rose-500"/><span>{v.error||"视频任务失败，额度已退回"}</span></div>)}
          {!videoRecords.length&&<div className="rounded-md border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500">完成的视频会保存在这里</div>}
        </div>
      </section>
    </div>
  </section>;
}
