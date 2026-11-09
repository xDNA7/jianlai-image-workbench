import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { TextField as BoardField, InputBase } from '../boardui/input'
import { Label } from '../boardui/label'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Dialog, Modal, ModalOverlay } from 'react-aria-components'
import { RefreshCw, Search, LogOut, Plus, Trash2, FolderOpen, Image as ImageIcon } from 'lucide-react'
import { adminLoginSchema, adminRechargeSchema, adminSessionSchema, adminTemplateSchema, adminUserSchema, adminImageSchema } from '../schemas/admin'
import accountAvatar from '../assets/account-avatar.webp'
import { assetUrl } from '../chat/api'

type Row = Record<string, any>
const prefix = typeof window !== 'undefined' && (window.location.pathname.startsWith('/jianlai-test/') || window.location.search.includes('testPath=1')) ? '/jianlai-test/' : '/jianlai/'
const categories: Record<string, string> = { fun:'人像趣味', policy:'销售政策', reward:'销售奖励', ranking:'排行榜', poster:'海报', comic:'漫画', infographic:'信息图', social:'社交媒体' }
const money = (n: unknown) => `¥${Number(n || 0).toFixed(2)}`
const date = (n: unknown) => n ? new Date(Number(n) < 1e11 ? Number(n) * 1000 : Number(n)).toLocaleString('zh-CN') : '—'

function AdminWorkPreview({ image, apiRoot }: { image: Row; apiRoot: string }) {
  const fallback = `${apiRoot}images/${encodeURIComponent(image.jobId)}/${image.index}`
  const direct = image.url || image.previewUrl
  const [fallbackOnly, setFallbackOnly] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => { setFallbackOnly(false); setUnavailable(false) }, [direct, fallback])
  const protectedSource = fallbackOnly || !direct
  const src = protectedSource ? fallback : direct
  return unavailable ? <div className="admin-state"><ImageIcon size={18}/><p>图片暂时无法预览</p><Button variant="outline" size="sm" onClick={() => { setFallbackOnly(false); setUnavailable(false) }}>重新加载图片</Button></div> : <a href={protectedSource ? fallback : image.downloadUrl || fallback} target="_blank" rel="noreferrer"><img src={src} alt="用户作品" loading="lazy" referrerPolicy="no-referrer" onError={() => { if (src !== fallback) setFallbackOnly(true); else setUnavailable(true) }}/></a>
}

function readError(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return `${fallback}：返回的数据格式不兼容，请刷新重试。`
  return error instanceof Error ? `${fallback}：${error.message}` : fallback
}

export function AdminApp() {
  const path = typeof window !== 'undefined' ? window.location.pathname : ''
  const match = path.match(/\/manage\/([A-Za-z0-9_-]+)(?:\/|$)/)
  const [apiRoot] = useState(() => match ? `${prefix}api/admin/${encodeURIComponent(match[1])}/` : '')
  const [session, setSession] = useState<Row>({})
  const [csrf, setCsrf] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const loginForm = useForm<z.infer<typeof adminLoginSchema>>({ defaultValues: { username: '', password: '' } })
  const rechargeForm = useForm<z.infer<typeof adminRechargeSchema>>({ defaultValues: { amount: '' } })
  const [tab, setTab] = useState<'overview'|'templates'|'works'>('overview')
  const [images, setImages] = useState<Row[]>([])
  const [activeUser, setActiveUser] = useState('')
  const [imagesLoading, setImagesLoading] = useState(false)
  const [imagesError, setImagesError] = useState('')
  const imageRequest = useRef(0)
  const userSelected = useRef(false)
  const [userSearch, setUserSearch] = useState('')
  const [query, setQuery] = useState('')
  const [authorOpen, setAuthorOpen] = useState(false)
  const [authorMode, setAuthorMode] = useState<'upload'|'generate'>('upload')
  const [authorPrompt, setAuthorPrompt] = useState('')
  const [authorImage, setAuthorImage] = useState('')
  const [draft, setDraft] = useState<Row>({ id:'', title:'', category:'poster', tags:'', prompt:'', text:'', size:'1024x1024', quality:'low', preview:'' })
  const queryClient = useQueryClient()

  const templatesQuery = useQuery({ queryKey:['admin',apiRoot,'templates'], queryFn:async()=>adminTemplateSchema.array().parse((await api('templates')).templates || []), enabled:Boolean(apiRoot && session.authenticated), retry:false })
  const usersQuery = useQuery({ queryKey:['admin',apiRoot,'users'], queryFn:async()=>adminUserSchema.array().parse((await api('users')).users || []), enabled:Boolean(apiRoot && session.authenticated), retry:false })
  const templates = templatesQuery.data || []
  const users = usersQuery.data || []

  async function api(endpoint: string, options: RequestInit = {}) {
    if (!apiRoot) throw new Error('管理入口无效，请使用已配置的管理地址')
    const headers = new Headers(options.headers)
    headers.set('Content-Type', 'application/json')
    if (options.method && options.method !== 'GET' && endpoint !== 'login') headers.set('X-CSRF-Token', csrf)
    const response = await fetch(apiRoot + endpoint, { ...options, headers, credentials: 'same-origin' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 401 && endpoint !== 'login') setSession({ authenticated: false })
      throw new Error(data.error || data.message || '请求失败')
    }
    return data
  }
  const applySession = (data: Row) => { const parsed = adminSessionSchema.parse(data); setSession(parsed); if (parsed.csrf) setCsrf(parsed.csrf) }
  const refresh = async () => { const data = await api('session'); applySession(data); return data }
  const loadTemplates = async () => { await queryClient.invalidateQueries({ queryKey:['admin',apiRoot,'templates'] }); return templatesQuery.refetch() }
  const loadUsers = async () => { await queryClient.invalidateQueries({ queryKey:['admin',apiRoot,'users'] }); return usersQuery.refetch() }
  async function refreshLists() { await Promise.all([loadTemplates(), loadUsers()]) }
  useEffect(() => {
    let active = true
    ;(async () => {
      try { if (apiRoot) { const data = await refresh(); if (active && data.authenticated) await refreshLists() } }
      catch (e) { if (active && (e as Error).message !== '请登录管理员账号') setError((e as Error).message) }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [apiRoot])

  async function login(input: z.infer<typeof adminLoginSchema>) {
    setLoading(true); setError('')
    try { const data = await api('login', { method:'POST', body:JSON.stringify(adminLoginSchema.parse(input)) }); applySession(data); loginForm.resetField('password'); await refreshLists() }
    catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  async function logout() { try { await api('logout', { method:'POST', body:'{}' }) } catch {} imageRequest.current += 1; setImages([]); setActiveUser(''); userSelected.current = false; setImagesLoading(false); setImagesError(''); setSession({ authenticated:false }); setCsrf('') }
  async function recharge(input: z.infer<typeof adminRechargeSchema>) {
    setError(''); const parsed = adminRechargeSchema.safeParse(input)
    if (!parsed.success) { setError(parsed.error.issues[0].message); return }
    const value = Number(parsed.data.amount)
    if (!confirm(`确认增加共享额度 ${money(value)}？`)) return
    try { await api('recharge', { method:'POST', body:JSON.stringify({ amount:value.toFixed(2), requestKey:crypto.randomUUID() }) }); rechargeForm.reset(); await refresh(); setNotice('额度已增加') }
    catch (e) { setError((e as Error).message) }
  }
  async function loadImages(id: string) {
    const request = ++imageRequest.current
    setActiveUser(id); setImages([]); setImagesError(''); setImagesLoading(true)
    try {
      const result = adminImageSchema.array().parse((await api(`users/${encodeURIComponent(id)}/images`)).images || [])
      if (imageRequest.current === request) setImages(result)
    } catch (error) {
      if (imageRequest.current === request) setImagesError(readError(error, '读取用户作品失败'))
    } finally {
      if (imageRequest.current === request) setImagesLoading(false)
    }
  }
  async function deleteImage(image: Row) {
    if (!confirm('永久删除这张作品？此操作无法恢复。')) return
    try { await api(`images/${encodeURIComponent(image.jobId)}/${image.index}`, { method:'DELETE' }); await loadImages(activeUser); await loadUsers(); setNotice('图片已永久删除') }
    catch (e) { setError((e as Error).message) }
  }
  async function deleteTemplate(item: Row) {
    if (!confirm(`删除模板「${item.title}」？`)) return
    try { await api(`templates/${encodeURIComponent(item.id)}`, { method:'DELETE' }); await loadTemplates(); setNotice('模板已删除') }
    catch (e) { setError((e as Error).message) }
  }
  async function startAuthor() {
    setError('')
    if (authorMode === 'upload' && !authorImage) { setError('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (authorMode === 'generate' && !authorPrompt.trim()) { setError('请输入生成提示词'); return }
    try {
      const input: Row = { mode:authorMode, requestKey:`author-${crypto.randomUUID()}`, size:draft.size, quality:draft.quality, prompt:authorPrompt.trim() }
      if (authorMode === 'upload') input.image = authorImage
      const started = await api('templates/author', { method:'POST', body:JSON.stringify(input) })
      setNotice('模板创作任务已提交，正在读取结果…')
      for (let i=0;i<360;i++) {
        const result = await api(`templates/author/${started.id}`)
        if (result.status === 'failed') throw new Error(result.error || '模板创作失败')
        if (result.status !== 'running') {
          if (!result.template) throw new Error('任务未返回模板草稿')
          setDraft({ ...draft, ...result.template, id:result.template.id || draft.id, tags:(result.template.tags || []).join(',') })
          await loadTemplates(); setNotice('模板草稿已生成，请检查后保存'); return
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('等待超时，可重新读取任务')
    } catch (e) { setError((e as Error).message) }
  }
  async function saveTemplate(event: FormEvent) {
    event.preventDefault(); setError('')
    if (!draft.title.trim() || !draft.prompt.trim()) { setError('请填写模板名称与提示词'); return }
    const template = { ...draft, tags:String(draft.tags).split(/[,，]/).map(x=>x.trim()).filter(Boolean).slice(0,12), mode:'reference', requiresImage:false, supportsFaceSwap:false, parameters:[], parameterDefaults:{} }
    try { await api('templates', { method:'POST', body:JSON.stringify({ template }) }); await loadTemplates(); setAuthorOpen(false); setNotice('模板已保存') }
    catch (e) { setError((e as Error).message) }
  }
  async function pickImage(file?: File) {
    if (!file) return
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 10*1024*1024) { setError('图片须为 PNG、JPEG 或 WebP，最多 10MB'); return }
    const reader = new FileReader(); reader.onload = () => setAuthorImage(String(reader.result)); reader.readAsDataURL(file)
  }
  function openAuthor() {
    setDraft({ id:`admin-${crypto.randomUUID()}`,title:'',category:'poster',tags:'',prompt:'',text:'',size:'1024x1024',quality:'low',preview:'' }); setAuthorPrompt(''); setAuthorImage(''); setAuthorMode('upload'); setAuthorOpen(true); setError('')
  }
  const filteredTemplates = useMemo(() => templates.filter(t => `${t.title || ''} ${(t.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [templates, query])
  const sortedUsers = useMemo(() => [...users].sort((a, b) => {
    if (a.lastCreated == null && b.lastCreated != null) return 1
    if (a.lastCreated != null && b.lastCreated == null) return -1
    const latest = (b.lastCreated ?? 0) - (a.lastCreated ?? 0)
    return latest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }), [users])
  const filteredUsers = useMemo(() => sortedUsers.filter(u => u.id.toLowerCase().includes(userSearch.toLowerCase())), [sortedUsers, userSearch])

  useEffect(() => {
    if (tab !== 'works' || !session.authenticated || !usersQuery.isSuccess || usersQuery.isFetching) return
    if (userSelected.current && activeUser && sortedUsers.some(user => user.id === activeUser)) return
    userSelected.current = false
    const first = sortedUsers.find(user => (user.imageCount || 0) > 0) || sortedUsers[0]
    if (first) { if (first.id !== activeUser) void loadImages(first.id) }
    else { imageRequest.current += 1; setActiveUser(''); setImages([]); setImagesLoading(false); setImagesError('') }
  }, [tab, session.authenticated, sortedUsers, usersQuery.isSuccess, usersQuery.isFetching, activeUser])

  return <main className={`admin-shell${session.authenticated && tab === 'works' ? ' admin-shell-works' : ''}`}>
    <header className="admin-header"><div className="admin-brand"><img src={accountAvatar} alt="刀盾狗" width={36} height={36} className="admin-brand-avatar"/><div><strong>剑来 · 管理中台</strong><small>生成服务运营工作台</small></div></div>{session.authenticated && <div className="admin-user"><span>{session.username || '管理员'}</span><Button variant="ghost" size="sm" onClick={logout}><LogOut size={16}/>退出</Button></div>}</header>
    {loading ? <p role="status" className="admin-state">正在连接管理服务…</p> : !apiRoot ? <p role="alert" className="admin-state">管理入口无效，请从服务端配置的随机管理地址进入。</p> : !session.authenticated ? <Card className="admin-login"><p className="eyebrow">SECURE ACCESS / ADMIN</p><h1>登录管理工作台</h1><p>管理共享额度、精选模板与用户作品。</p><form onSubmit={loginForm.handleSubmit(login)}><BoardField isRequired><Label>管理员账号</Label><InputBase {...loginForm.register('username')} autoComplete="username" required /></BoardField><BoardField isRequired><Label>密码</Label><InputBase {...loginForm.register('password')} type="password" autoComplete="current-password" required /></BoardField>{error && <p role="alert" className="admin-error">{error}</p>}<Button type="submit" disabled={loading}>登录</Button></form></Card> : <>
      <nav className="admin-nav" aria-label="管理工作区">{([['overview','额度总览'],['templates','模板管理'],['works','用户作品']] as const).map(([key,label])=><button key={key} className={tab===key?'active':''} onClick={()=>{setTab(key);setError('')}}>{label}</button>)}</nav>
      {error && <p role="alert" className="admin-error">{error}</p>}{notice && <p role="status" className="admin-notice">{notice}</p>}
      {tab==='overview' && <section className="admin-page"><div className="admin-title"><div><h1>额度总览</h1><p>共享生成池与近期服务状态</p></div><Button variant="outline" onClick={()=>refresh().catch(e=>setError(e.message))}><RefreshCw size={16}/>刷新</Button></div><Card className="admin-balance"><span>当前总余额</span><strong>{money(session.balance)}</strong><small>可用 {money(session.available ?? session.balance)} · 预留 {money(session.reserved)}</small></Card><form className="admin-recharge" onSubmit={rechargeForm.handleSubmit(recharge)}><label htmlFor="recharge">增加共享额度</label><div><input id="recharge" {...rechargeForm.register('amount')} inputMode="decimal" placeholder="充值金额（元）"/><Button type="submit">确认充值</Button></div></form><dl className="admin-stats">{[['精选模板',session.stats?.templateCount ?? templates.length],['近 30 天用户',session.stats?.userCount ?? '—'],['近 30 天作品',session.stats?.imageCount ?? '—'],['生成中',session.stats?.runningCount ?? '—']].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="admin-retention">用户可见期 14 天 · 管理员保留期 30 天。永久删除会同时清理 OSS 图片。</p></section>}
      {tab==='templates' && <section className="admin-page"><div className="admin-title"><div><h1>精选模板</h1><p>{templates.length} 个模板 · 按需搜索与维护</p></div><Button onClick={openAuthor}><Plus size={16}/>新增模板</Button></div><label className="admin-search"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索模板名称或标签" /></label><div className="admin-template-list">{filteredTemplates.map(t=><article key={t.id}>{t.preview && <img src={assetUrl(t.preview)} alt={t.title} loading="lazy" referrerPolicy="no-referrer"/>}<div><strong>{t.title}</strong><small>{categories[t.category || '']||'其他'} · {(t.tags||[]).join(' · ')}</small></div><Button variant="ghost" size="sm" aria-label={`删除模板 ${t.title}`} onClick={()=>deleteTemplate(t)}><Trash2 size={16}/></Button></article>)}{!filteredTemplates.length && <p className="admin-state">没有符合条件的模板。</p>}</div></section>}
      {tab==='works' && <section className="admin-page admin-works-page"><div className="admin-title"><div><h1>用户作品</h1><p>查看最近 30 天的用户作品，选择账户可切换目录。</p></div><Button variant="outline" onClick={()=>loadUsers().catch(e=>setError(e.message))}><RefreshCw size={16}/>刷新目录</Button></div><div className="admin-work-layout"><aside><label className="admin-search"><Search size={16}/><input value={userSearch} onChange={e=>setUserSearch(e.target.value)} placeholder="筛选账户" aria-label="筛选账户"/></label><div className="admin-user-list" role="region" aria-label="用户列表" tabIndex={0}>{usersQuery.isFetching || usersQuery.isPending ? <p role="status" className="admin-state">正在读取账户目录…</p> : usersQuery.isError ? <div className="admin-state"><p role="alert">{readError(usersQuery.error, '读取账户目录失败')}</p><Button variant="outline" onClick={()=>void usersQuery.refetch()}>重试账户目录</Button></div> : null}{filteredUsers.map(u=><button key={u.id} className={`admin-folder ${activeUser===u.id?'active':''}`} aria-pressed={activeUser===u.id} onClick={()=>{userSelected.current = true; void loadImages(u.id)}}><FolderOpen size={16}/><span><strong>账户 {String(u.id).slice(0,12)}</strong><small>{u.imageCount} 张 · 最近 {date(u.lastCreated)}</small></span></button>)}{!usersQuery.isPending && !usersQuery.isFetching && !usersQuery.isError && !filteredUsers.length && <p className="admin-state">{userSearch ? '没有匹配的账户' : '暂无保留作品'}</p>}</div></aside><div className="admin-work-grid" role="region" aria-label="用户作品" tabIndex={0} aria-busy={imagesLoading}>{imagesLoading ? <p role="status" className="admin-state">正在读取用户作品…</p> : imagesError ? <div className="admin-state"><p role="alert">{imagesError}</p><Button variant="outline" onClick={()=>void loadImages(activeUser)}>重试用户作品</Button></div> : !activeUser ? <p className="admin-state">选择账户目录查看作品</p> : !images.length ? <p className="admin-state">该账户当前没有保留作品</p> : images.map(image=><article key={image.id}><AdminWorkPreview image={image} apiRoot={apiRoot}/><small>{date(image.created)} · {image.hiddenUser?'用户不可见':'用户可见'}</small><small>后台到期 {date(image.expiresAt)}</small><Button variant="ghost" size="sm" onClick={()=>deleteImage(image)}><Trash2 size={16}/>永久删除</Button></article>)}</div></div></section>}
    </>}
    <ModalOverlay className="admin-overlay" isOpen={authorOpen} onOpenChange={setAuthorOpen} isDismissable>
      <Modal className="admin-dialog"><Dialog aria-labelledby="author-title" className="admin-dialog-content">
        <div className="admin-title"><h2 id="author-title">新增精选模板</h2><Button variant="ghost" onClick={()=>setAuthorOpen(false)}>关闭</Button></div><div className="admin-nav"><button className={authorMode==='upload'?'active':''} onClick={()=>setAuthorMode('upload')}>从例图解析</button><button className={authorMode==='generate'?'active':''} onClick={()=>setAuthorMode('generate')}>生成例图</button></div><label>{authorMode==='upload'?'上传参考例图':'生成提示词'}{authorMode==='upload'?<><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>pickImage(e.target.files?.[0])}/>{authorImage&&<img className="author-preview" src={authorImage} alt="上传例图"/>}</>:<textarea value={authorPrompt} onChange={e=>setAuthorPrompt(e.target.value)} placeholder="描述主体、构图、配色与画面文字"/>}</label><Button onClick={startAuthor}>提交创作任务</Button><form className="admin-author-form" onSubmit={saveTemplate}><label>模板名称<input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} required/></label><label>分类<select value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value})}>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>标签<input value={draft.tags} onChange={e=>setDraft({...draft,tags:e.target.value})} placeholder="用逗号分隔"/></label><label>提示词<textarea value={draft.prompt} onChange={e=>setDraft({...draft,prompt:e.target.value})} rows={5} required/></label><label>画面文字<input value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/></label><label>预览 HTTPS 地址<input value={draft.preview} onChange={e=>setDraft({...draft,preview:e.target.value})} placeholder="https://…"/></label>{error&&<p role="alert" className="admin-error">{error}</p>}<Button type="submit">保存模板</Button></form>
      </Dialog></Modal></ModalOverlay>
    </main>
}
