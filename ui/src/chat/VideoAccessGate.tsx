import { useState, type ReactNode } from 'react'
import { Button } from '@/boardui/button'
import type { VideoAccess } from './useVideoAccess'

export function VideoAccessGate({ access, children }: { access: VideoAccess; children: ReactNode }) {
  const [password, setPassword] = useState('')
  if (access.authenticated) return <>
    <div className="flex items-center justify-between gap-3 px-5 pt-4 text-sm text-muted-foreground">
      <span>内部视频工作区 · <a className="underline underline-offset-2" href="https://github.com/xDNA7/jianlai-image-workbench" target="_blank" rel="noopener noreferrer">源码与许可</a></span>
      <Button variant="ghost" disabled={access.working} onClick={() => { void access.logout() }}>退出内部视频</Button>
    </div>
    {access.error ? <p role="alert" className="px-5 text-sm text-destructive">{access.error}</p> : null}
    {children}
  </>
  return <section className="mx-auto grid w-full max-w-md gap-4 p-6 py-12" aria-label="视频内部登录">
    <h1 className="text-xl font-semibold">内部视频工作区</h1>
    <p className="text-sm text-muted-foreground">请输入内部访问口令后使用视频创作。图片创作可继续使用。</p>
    {access.loading ? <p role="status">正在核对访问权限…</p> : <form className="grid gap-4" onSubmit={event => {
      event.preventDefault()
      const value = password
      setPassword('')
      void access.login(value)
    }}>
      <label className="grid gap-2 text-sm">视频访问口令
        <input className="min-h-11 rounded-lg border border-border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring" type="password" autoComplete="current-password" maxLength={2048} required value={password} onChange={event => setPassword(event.target.value)} disabled={access.working} />
      </label>
      <Button type="submit" disabled={access.working || !password.trim()}>{access.working ? '正在验证…' : '进入视频工作台'}</Button>
    </form>}
    {access.error ? <div className="grid gap-2"><p role="alert" className="text-sm text-destructive">{access.error}</p><Button variant="ghost" disabled={access.working} onClick={access.retry}>重新核对访问权限</Button></div> : null}
  </section>
}
