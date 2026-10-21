declare module 'uqr' {
  export interface RenderOptions {
    ecc?: 'L' | 'M' | 'Q' | 'H';
    border?: number;
  }

  export function renderSVG(text: string | Uint8Array, options?: RenderOptions): string;
}
