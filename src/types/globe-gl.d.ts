declare module 'globe.gl' {
  export interface ConfigOptions {
    [key: string]: unknown;
  }

  export type GlobeInstance = any;

  const Globe: {
    new (element: HTMLElement, config?: ConfigOptions): GlobeInstance;
  };

  export default Globe;
}
