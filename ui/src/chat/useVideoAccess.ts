import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './api'
import { videoAccessExpiredEvent } from './video-access-events'
import type { components } from '../api/generated'

type Access = components['schemas']['VideoAccess']
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : '内部验证暂时不可用，请重试'

/** Shares the authorization boundary with the gallery, studio and player. */
export function useVideoAccess(accountId: string | null) {
  const client = useQueryClient()
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const key = ['video-access', accountId] as const
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request<Access>('video-access', { signal }),
    enabled: Boolean(accountId),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
  const authenticated = Boolean(accountId && query.data?.authenticated && !query.isError)
  useEffect(() => {
    if (authenticated) return
    for (const prefix of ['videos', 'video-job']) {
      void client.cancelQueries({ queryKey: [prefix, accountId] })
      client.removeQueries({ queryKey: [prefix, accountId] })
    }
  }, [authenticated, client, accountId])
  const clear = useCallback(() => {
    void client.cancelQueries({ queryKey: ['video-access', accountId], exact: true })
    client.setQueryData<Access>(['video-access', accountId], { authenticated: false, enabled: true, expiresAt: null })
    for (const prefix of ['videos', 'video-job']) {
      void client.cancelQueries({ queryKey: [prefix, accountId] })
      client.removeQueries({ queryKey: [prefix, accountId] })
    }
    // Keep pending paid request keys in sessionStorage for safe reconciliation.
  }, [client, accountId])
  useEffect(() => {
    const expired = () => { clear(); setError('视频登录已过期，请重新输入访问口令') }
    window.addEventListener(videoAccessExpiredEvent, expired)
    return () => window.removeEventListener(videoAccessExpiredEvent, expired)
  }, [clear])
  useEffect(() => {
    if (!authenticated) return
    const expiry = query.data?.expiresAt
    if (!expiry || !Number.isFinite(expiry)) return
    const timer = setTimeout(() => { clear(); setError('视频登录已过期，请重新输入访问口令') }, Math.max(0, expiry - Date.now()))
    return () => clearTimeout(timer)
  }, [authenticated, query.data?.expiresAt, clear])
  const login = async (password: string) => {
    if (!accountId || working) return
    setWorking(true)
    setError('')
    try {
      const access = await request<Access>('video-access', { method: 'POST', body: JSON.stringify({ password }) })
      await client.cancelQueries({ queryKey: key, exact: true })
      client.setQueryData(key, access)
      if (!access.authenticated) throw new Error('内部验证未通过')
      void client.invalidateQueries({ queryKey: ['videos', accountId], exact: true })
    } catch (reason) { setError(messageOf(reason)) }
    finally { setWorking(false) }
  }
  const logout = async () => {
    if (working) return
    setWorking(true)
    setError('')
    try {
      await request('video-access', { method: 'DELETE' })
      clear()
    } catch (reason) { setError(`退出失败，请重试：${messageOf(reason)}`) }
    finally { setWorking(false) }
  }
  return { authenticated, loading: !accountId || query.isPending, working, error: error || (query.isError ? messageOf(query.error) : ''), login, logout, retry: () => { setError(''); void query.refetch() } }
}

export type VideoAccess = ReturnType<typeof useVideoAccess>
