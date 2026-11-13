declare module "*?raw" {
  const content: string;
  export default content;
}

declare namespace Cloudflare {
  interface Env {
    UPLOADS: R2Bucket;
  }
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
