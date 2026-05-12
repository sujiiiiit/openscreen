export interface Api {
  macAddon: {
    hello: () => Promise<string>
  }
}

declare global {
  interface Window {
    api: Api
  }
}

export {}
