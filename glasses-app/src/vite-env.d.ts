/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string
  readonly VITE_APP_TOKEN?: string
  readonly VITE_SESSION?: string
  // "lat,lon" for dev and the simulator, which has no location.
  readonly VITE_FAKE_LOCATION?: string
}
