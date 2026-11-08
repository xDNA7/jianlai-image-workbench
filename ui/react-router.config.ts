import type { Config } from '@react-router/dev/config'

export default {
  ssr: false,
  appDirectory: 'app',
  basename: process.env.VITE_APP_BASE || '/jianlai/',
} satisfies Config
