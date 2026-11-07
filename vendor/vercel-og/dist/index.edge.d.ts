import { ReactElement } from 'react';
import { ImageResponseOptions } from './types.js';
import 'satori';
import 'http';

declare class ImageResponse extends Response {
    constructor(element: ReactElement, options?: ImageResponseOptions);
}
type EdgeImageResponse = typeof ImageResponse;

export { EdgeImageResponse, ImageResponse, ImageResponseOptions };
