import type { LinksFunction } from 'react-router'
import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import stylesheet from '../src/style.css?url'
import { AppStatus } from '../src/pwa/AppStatus'

export const links: LinksFunction = () => [
  { rel: 'stylesheet', href: stylesheet },
  { rel: 'manifest', href: `${import.meta.env.BASE_URL}manifest.webmanifest` },
  { rel: 'icon', href: `${import.meta.env.BASE_URL}icons/icon-192.png`, type: 'image/png', sizes: '192x192' },
  { rel: 'apple-touch-icon', href: `${import.meta.env.BASE_URL}icons/apple-touch-icon.png` },
]

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <title>剑来生图</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="theme-color" content="#f7f8fa" />
        <meta name="description" content="剑来生图工作台" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <QueryClientProvider client={queryClient}><Outlet /><AppStatus /></QueryClientProvider>
}

export function ErrorBoundary() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : '页面暂时无法加载'
  return (
    <main className="route-not-found">
      <section>
        <p className="eyebrow">WORKBENCH / ERROR</p>
        <h1>工作台需要重新加载</h1>
        <p>{message}。请刷新页面，未提交的内容不会被自动发送。</p>
        <a href="/jianlai/">返回工作台</a>
      </section>
    </main>
  )
}
