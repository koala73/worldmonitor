import { strict as assert } from 'node:assert';
import test from 'node:test';
import { XMLLoader } from '@loaders.gl/xml';
import { WMSCapabilitiesLoader, WMSErrorLoader, _WMSFeatureInfoLoader } from '@loaders.gl/wms';

const WMS_CAPABILITIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Service>
    <Name>WMS</Name>
    <Title>Test Service</Title>
    <KeywordList>
      <Keyword>alerts</Keyword>
      <Keyword>world</Keyword>
    </KeywordList>
  </Service>
  <Capability>
    <Request>
      <GetMap>
        <Format>image/png</Format>
        <Format>image/jpeg</Format>
      </GetMap>
    </Request>
    <Exception>
      <Format>application/vnd.ogc.se_xml</Format>
    </Exception>
    <Layer>
      <Title>Root Layer</Title>
      <CRS>EPSG:4326</CRS>
      <EX_GeographicBoundingBox>
        <westBoundLongitude>-180</westBoundLongitude>
        <eastBoundLongitude>180</eastBoundLongitude>
        <southBoundLatitude>-90</southBoundLatitude>
        <northBoundLatitude>90</northBoundLatitude>
      </EX_GeographicBoundingBox>
      <Layer queryable="1">
        <Name>alerts</Name>
        <Title>Alerts</Title>
        <BoundingBox CRS="EPSG:4326" minx="-10" miny="-20" maxx="30" maxy="40" />
        <Dimension name="time" units="ISO8601" default="2024-01-01" nearestValue="1">
          2024-01-01/2024-12-31/P1D
        </Dimension>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

test('XMLLoader keeps namespace stripping + array paths stable', () => {
  const xml = '<root><ns:Child attr="x">ok</ns:Child><ns:Child attr="y">yo</ns:Child></root>';
  const parsed = XMLLoader.parseTextSync(xml, {
    xml: {
      removeNSPrefix: true,
      arrayPaths: ['root.Child'],
    },
  });

  assert.deepEqual(parsed, {
    root: {
      Child: [
        { value: 'ok', attr: 'x' },
        { value: 'yo', attr: 'y' },
      ],
    },
  });
});

test('WMSCapabilitiesLoader parses core typed fields from XML capabilities', () => {
  const parsed = WMSCapabilitiesLoader.parseTextSync(WMS_CAPABILITIES_XML);

  assert.equal(parsed.version, '1.3.0');
  assert.equal(parsed.name, 'WMS');
  assert.deepEqual(parsed.requests.GetMap.mimeTypes, ['image/png', 'image/jpeg']);

  assert.equal(parsed.layers.length, 1);
  const rootLayer = parsed.layers[0];
  assert.deepEqual(rootLayer.geographicBoundingBox, [[-180, -90], [180, 90]]);

  const alertsLayer = rootLayer.layers[0];
  assert.equal(alertsLayer.name, 'alerts');
  assert.equal(alertsLayer.queryable, true);
  assert.deepEqual(alertsLayer.boundingBoxes[0], {
    crs: 'EPSG:4326',
    boundingBox: [[-10, -20], [30, 40]],
  });
  assert.deepEqual(alertsLayer.dimensions[0], {
    name: 'time',
    units: 'ISO8601',
    extent: '2024-01-01/2024-12-31/P1D',
    defaultValue: '2024-01-01',
    nearestValue: true,
  });
});

test('WMSErrorLoader extracts namespaced error text and honors throw options', () => {
  const namespacedErrorXml =
    '<?xml version="1.0"?><ogc:ServiceExceptionReport><ogc:ServiceException code="LayerNotDefined">Bad layer</ogc:ServiceException></ogc:ServiceExceptionReport>';

  const defaultMessage = WMSErrorLoader.parseTextSync(namespacedErrorXml);
  assert.equal(defaultMessage, 'WMS Service error: Bad layer');

  const minimalMessage = WMSErrorLoader.parseTextSync(namespacedErrorXml, {
    wms: { minimalErrors: true },
  });
  assert.equal(minimalMessage, 'Bad layer');

  assert.throws(
    () => WMSErrorLoader.parseTextSync(namespacedErrorXml, { wms: { throwOnError: true } }),
    /WMS Service error: Bad layer/
  );
});

test('WMS feature info parsing remains stable for single and repeated FIELDS nodes', () => {
  const singleFieldsXml = '<?xml version="1.0"?><FeatureInfoResponse><FIELDS id="1" label="one"/></FeatureInfoResponse>';
  const manyFieldsXml = '<?xml version="1.0"?><FeatureInfoResponse><FIELDS id="1"/><FIELDS id="2"/></FeatureInfoResponse>';

  const single = _WMSFeatureInfoLoader.parseTextSync(singleFieldsXml);
  const many = _WMSFeatureInfoLoader.parseTextSync(manyFieldsXml);

  assert.equal(single.features.length, 1);
  assert.deepEqual(single.features[0]?.attributes, { id: '1', label: 'one' });
  assert.equal(many.features.length, 2);
  assert.equal(many.features[0]?.attributes?.id, '1');
  assert.equal(many.features[1]?.attributes?.id, '2');
});
