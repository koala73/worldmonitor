/**
 * Common type definitions for World Monitor
 * @module types/common
 */

/**
 * Geographic coordinates (latitude, longitude)
 */
export interface Coordinates {
  /** Latitude in degrees (-90 to 90) */
  lat: number;
  /** Longitude in degrees (-180 to 180) */
  lng: number;
}

/**
 * Bounding box for map regions
 */
export interface BoundingBox {
  /** North boundary */
  north: number;
  /** South boundary */
  south: number;
  /** East boundary */
  east: number;
  /** West boundary */
  west: number;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  /** Response data */
  data: T;
  /** Response timestamp */
  timestamp: string;
  /** Request ID for tracking */
  requestId?: string;
}

/**
 * Error response structure
 */
export interface ApiError {
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}
