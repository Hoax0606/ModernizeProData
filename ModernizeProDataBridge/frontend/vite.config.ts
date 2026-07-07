import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // sockjs-client 가 Node 의 `global` 을 module-level 에서 참조한다.
  // 브라우저에는 그 심볼이 없어서 import 만 해도 ReferenceError 가 나며 App 전체가 죽는다.
  // Vite 의 define 으로 빌드·dev 양쪽에서 globalThis 로 대체.
  define: {
    global: 'globalThis',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
