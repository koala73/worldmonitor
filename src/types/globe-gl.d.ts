declare module 'globe.gl' {
  export interface ConfigOptions {
    [key: string]: unknown;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface GlobeInstance {
    pointOfView(pov?: { lat?: number; lng?: number; altitude?: number }, transitionMs?: number): { lat: number; lng: number; altitude: number };
    toGlobeCoords(x: number, y: number): { lat: number; lng: number } | null;
    globeImageUrl(url: string): GlobeInstance;
    htmlElementsData(data: unknown[]): GlobeInstance;
    scene(): any;
    controls(): any;
    camera(): any;
    renderer(): any;
    width(w?: number): any;
    height(h?: number): any;
    pauseAnimation(): GlobeInstance;
    resumeAnimation(): GlobeInstance;
    [method: string]: any;
  }

  const Globe: {
    new (element: HTMLElement, config?: ConfigOptions): GlobeInstance;
  };

  export default Globe;
}
