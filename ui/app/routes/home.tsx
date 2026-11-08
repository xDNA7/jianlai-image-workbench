import { useSearchParams } from 'react-router'
import { ChatApp } from '../../src/chat/ChatApp'
import { WorkbenchApp } from '../../src/main'

export default function Home() {
  const [search] = useSearchParams()
  return search.get('legacy') === '1' ? <WorkbenchApp /> : <ChatApp />
}
