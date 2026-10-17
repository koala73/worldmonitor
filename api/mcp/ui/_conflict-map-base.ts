import { geoEquirectangular, geoPath } from 'd3';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import world from '../../../public/data/countries-110m.json' with { type: 'json' };

const width = 720;
const height = 384;
const scale = (width - 64) / (2 * Math.PI);
const translate: [number, number] = [width / 2, height / 2];
const projection = geoEquirectangular().scale(scale).translate(translate);
const countries = feature(world as unknown as Topology, world.objects.countries as GeometryCollection);

export const CONFLICT_MAP_BASE = {
  width, height, scale, translate,
  path: geoPath(projection).digits(0)(countries) || '',
};
