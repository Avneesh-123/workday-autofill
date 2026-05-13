/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*.svg" {
  const src: string;
  export default src;
}
