import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { VideoStudio } from '../main'
import { getVideo, loadVideos, request } from './api'
import { videoFormSchema, type VideoFormValues } from './schemas'

type Props = {
  balance: number | null
  onBalance: (cents?: number | null) => void
}

/** Wraps the existing video generator with its own state and job polling. */
export default function VideoPane({ balance, onBalance }: Props) {
  const [job, setJob] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // VideoStudio remains as the rollback surface; RHF owns its validated input
  // values while its existing request-key and retry mechanics remain intact.
  const form = useForm<VideoFormValues>({
    defaultValues: { prompt: '', image: null, seconds: 5, ratio: '16:9', resolution: '768P' },
  })
  const values = form.watch()

  const queryClient = useQueryClient()
  const recordsQuery = useQuery({ queryKey: ['videos'], queryFn: loadVideos, retry: 1 })
  const activeQuery = useQuery({
    queryKey: ['video-job', job?.id],
    queryFn: () => getVideo(job.id),
    enabled: Boolean(job?.id && !['done', 'failed'].includes(job.status)),
    refetchInterval: (query) => {
      const status = query.state.data?.status ?? job?.status
      return status && !['done', 'failed'].includes(status) ? 10_000 : false
    },
    retry: 1,
  })

  useEffect(() => {
    request('bootstrap').then((v) => v.activeVideo && setJob(v.activeVideo)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!activeQuery.data) return
    setJob(activeQuery.data)
    if (['done', 'failed'].includes(activeQuery.data.status)) {
      setBusy(false)
      setError(activeQuery.data.status === 'failed' ? activeQuery.data.error || '' : '')
      void queryClient.invalidateQueries({ queryKey: ['videos'] })
      onBalance(activeQuery.data.availableCents)
    }
  }, [activeQuery.data, onBalance, queryClient])

  useEffect(() => {
    if (activeQuery.isError) setError('状态暂时无法读取，任务仍会在服务端继续；稍后再试')
  }, [activeQuery.isError])

  const refreshVideos = () => queryClient.invalidateQueries({ queryKey: ['videos'] })
  const setField = <K extends keyof VideoFormValues>(key: K, value: VideoFormValues[K]) => {
    const next = { ...form.getValues(), [key]: value }
    if (!videoFormSchema.safeParse(next).success) return
    form.setValue(key, value as never, { shouldDirty: true, shouldValidate: true })
  }

  return (
    <div className="studio-shell mx-auto w-full max-w-5xl px-4 pb-10">
      <VideoStudio
        quota={balance}
        videoRecords={recordsQuery.data || []}
        videoJob={job}
        videoPrompt={values.prompt}
        setVideoPrompt={(value: string) => setField('prompt', value)}
        videoImage={values.image}
        setVideoImage={(value: string | null) => setField('image', value)}
        videoSeconds={values.seconds}
        setVideoSeconds={(value: number) => setField('seconds', value)}
        videoRatio={values.ratio}
        setVideoRatio={(value: string) => setField('ratio', value as VideoFormValues['ratio'])}
        videoResolution={values.resolution}
        setVideoResolution={(value: string) => setField('resolution', value as VideoFormValues['resolution'])}
        videoBusy={busy}
        setVideoBusy={setBusy}
        videoError={error}
        setVideoError={setError}
        setVideoJob={setJob}
        refreshQuota={onBalance}
        loadVideos={refreshVideos}
      />
    </div>
  )
}
