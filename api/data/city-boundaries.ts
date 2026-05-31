export const CITY_BOUNDARIES: Record<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> = {
  'san francisco': {
    type: 'Feature',
    properties: { city: 'San Francisco', country: 'USA' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-122.5150, 37.7081],
        [-122.3570, 37.7081],
        [-122.3570, 37.8324],
        [-122.5150, 37.8324],
        [-122.5150, 37.7081],
      ]],
    },
  },
  'new york': {
    type: 'Feature',
    properties: { city: 'New York', country: 'USA' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-74.25559, 40.49612],
        [-73.70001, 40.49612],
        [-73.70001, 40.91553],
        [-74.25559, 40.91553],
        [-74.25559, 40.49612],
      ]],
    },
  },
  'london': {
    type: 'Feature',
    properties: { city: 'London', country: 'UK' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-0.5103, 51.2868],
        [0.3340, 51.2868],
        [0.3340, 51.6919],
        [-0.5103, 51.6919],
        [-0.5103, 51.2868],
      ]],
    },
  },
  'paris': {
    type: 'Feature',
    properties: { city: 'Paris', country: 'France' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [2.2242, 48.8156],
        [2.4699, 48.8156],
        [2.4699, 48.9021],
        [2.2242, 48.9021],
        [2.2242, 48.8156],
      ]],
    },
  },
  'tokyo': {
    type: 'Feature',
    properties: { city: 'Tokyo', country: 'Japan' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [139.55, 35.58],
        [139.85, 35.58],
        [139.85, 35.75],
        [139.55, 35.75],
        [139.55, 35.58],
      ]],
    },
  },
  'beijing': {
    type: 'Feature',
    properties: { city: 'Beijing', country: 'China' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [116.0, 39.6],
        [116.8, 39.6],
        [116.8, 40.1],
        [116.0, 40.1],
        [116.0, 39.6],
      ]],
    },
  },
  'mumbai': {
    type: 'Feature',
    properties: { city: 'Mumbai', country: 'India' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [72.74, 18.90],
        [72.98, 18.90],
        [72.98, 19.21],
        [72.74, 19.21],
        [72.74, 18.90],
      ]],
    },
  },
  'delhi': {
    type: 'Feature',
    properties: { city: 'Delhi', country: 'India' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [76.84, 28.53],
        [77.35, 28.53],
        [77.35, 28.88],
        [76.84, 28.88],
        [76.84, 28.53],
      ]],
    },
  },
  'sydney': {
    type: 'Feature',
    properties: { city: 'Sydney', country: 'Australia' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [150.9, -34.1],
        [151.4, -34.1],
        [151.4, -33.7],
        [150.9, -33.7],
        [150.9, -34.1],
      ]],
    },
  },
  'singapore': {
    type: 'Feature',
    properties: { city: 'Singapore', country: 'Singapore' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [103.6, 1.2],
        [104.0, 1.2],
        [104.0, 1.5],
        [103.6, 1.5],
        [103.6, 1.2],
      ]],
    },
  },
};
