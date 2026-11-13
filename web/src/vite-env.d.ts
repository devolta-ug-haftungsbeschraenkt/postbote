/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POSTBOTE_API?: string
  readonly VITE_POSTBOTE_TOKEN?: string
  readonly VITE_LOGTO_ENDPOINT?: string
  readonly VITE_LOGTO_APP_ID?: string
  readonly VITE_LOGTO_RESOURCE?: string
  readonly VITE_LOGTO_SCOPES?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
