import urllib.request
import urllib.parse
import json

url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({
    'q': 'Paris, France',
    'format': 'json',
    'polygon_geojson': '1',
    'limit': '1',
    'addressdetails': '0',
})
print(url)
req = urllib.request.Request(url, headers={'User-Agent': 'worldmonitor-test/1.0'})
with urllib.request.urlopen(req, timeout=30) as resp:
    data = json.load(resp)
    print('status', resp.status)
    print('len', len(data))
    if data:
        print(data[0].get('osm_type'), data[0].get('geojson', {}).get('type'))
