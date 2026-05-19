# Bilawal WorldView and internet-3D notes

Source videos reviewed during the Sensor Fusion Deck update:

- `KWXuxfdZhwk` — **The Internet's Hidden 3D Model of the World**
- `rXvU7bPJ8n4` — **Ex-Google Maps PM Vibe Coded Palantir In a Weekend (Palantir Noticed)**

## Takeaways for WorldMonitor

### WorldView pattern

The second video describes a weekend-built geospatial dashboard combining:

- 3D globe / 3D tiles base map
- satellite tracking
- military and commercial flight data
- live CCTV / webcam feeds
- street traffic simulation
- seismic/earthquake data
- visual modes such as CRT, night vision, and FLIR
- parallel AI-agent implementation workflow

WorldMonitor already has many equivalent public-data lanes: 3D globe, deck.gl map, military flights/vessels, aircraft positions, seismic activity, thermal escalation, satellite/imagery footprints, webcams, weather, and many correlation panels.

### Internet 3D reconstruction pattern

The first video follows the arc from Structure-from-Motion and NeRFs to 3D Gaussian Splatting, VGGT, π³, and MegaDepth-X. The relevant product insight is not to ingest random private images. The useful lane is a provenance-reviewed research/asset pipeline for sparse 3D context:

1. public/owned imagery only;
2. explicit source attribution;
3. no private-person tracking;
4. separate roadmap status until privacy and provenance rules are documented;
5. local-first processing where possible.

## Implementation decision

Added a **Sensor Fusion Deck** instead of jumping straight to a 3D reconstruction feature. It gives operators a live inventory of what streams are fused now and marks sparse 3D reconstruction as planned/guardrailed.
