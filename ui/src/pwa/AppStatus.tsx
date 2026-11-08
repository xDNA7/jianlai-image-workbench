import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, WifiOff, X } from 'lucide-react'
import { Button } from '../boardui/button'
import './status.css'

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

/** Online-first: no service worker caches private responses or offline mutations. */
export function AppStatus() {
  const [online, setOnline] = useState(true)
  const [install, setInstall] = useState<InstallEvent | null>(null)
  const [update, setUpdate] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [iosHint, setIosHint] = useState(false)
  const version = useRef<string | null>(null)
  useEffect(() => {
    setOnline(navigator.onLine)
    const connected = () => { setOnline(true) }
    const disconnected = () => { setOnline(false) }
    const available = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent) }
    const installed = () => { setInstall(null); setIosHint(false) }
    const controller = new AbortController()
    const checkVersion = async () => {
      if (!navigator.onLine || document.visibilityState === 'hidden') return
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) return
        const next: unknown = await response.json()
        if (typeof next !== 'object' || next === null || !('version' in next) || typeof next.version !== 'string') return
        if (version.current && version.current !== next.version) setUpdate(true)
        version.current = next.version
      } catch { /* Connectivity status is handled by native events; do not erase drafts. */ }
    }
    setIosHint(/iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches)
    window.addEventListener('online', connected)
    window.addEventListener('offline', disconnected)
    window.addEventListener('beforeinstallprompt', available)
    window.addEventListener('appinstalled', installed)
    document.addEventListener('visibilitychange', checkVersion)
    void checkVersion()
    const interval = window.setInterval(checkVersion, 60_000)
    return () => { controller.abort(); clearInterval(interval); window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); window.removeEventListener('beforeinstallprompt', available); window.removeEventListener('appinstalled', installed); document.removeEventListener('visibilitychange', checkVersion) }
  }, [])
  if (!online) return <aside className="pwa-status" role="status"><WifiOff size={16} aria-hidden /><span>网络已断开。恢复连接后可继续；不会自动提交或扣费。</span></aside>
  if (dismissed || (!update && !install && !iosHint)) return null
  return <aside className="pwa-status" role="status">
    {update ? <><RefreshCw size={16} aria-hidden /><span>新版本已就绪。请先保存输入，刷新不会自动提交任务。</span><Button variant="secondary" size="small" onClick={() => window.location.reload()}>刷新</Button></> : install ? <><Download size={16} aria-hidden /><span>添加到主屏幕，下次更快打开。</span><Button variant="secondary" size="small" onClick={async () => { try { await install.prompt(); await install.userChoice; setInstall(null) } catch { setInstall(null) } }}>安装</Button></> : <span>可在 Safari 的分享菜单中选择“添加到主屏幕”。</span>}
    <Button variant="ghost" iconOnly size="small" leadingIcon={X} aria-label="暂时关闭提示" onClick={() => setDismissed(true)} />
  </aside>
}
