# Context: WorldMonitor

WorldMonitor is a real-time global intelligence dashboard that fuses public and self-hostable data streams into a situational awareness interface.

## Canonical terms

### Sensor Fusion Deck

A panel-level overview of which geospatial streams are currently fused into the dashboard and which are only roadmap lanes.

_Avoid_: calling it "Palantir" or "panopticon" in product UI. Those are inspiration/reference points, not product claims.

### Public OSINT feed

A data source that can be used with public attribution, documented provenance, and no hidden proprietary collection assumption.

_Avoid_: implying covert, private, or unconsented collection.

### Sparse 3D reconstruction

A roadmap capability for using sparse, provenance-reviewed imagery to add local 3D context. It is not an active surveillance feature.

_Avoid_: "God's eye view" in operator-facing UI except in research notes.

### WorldView-style layer

A visual/data-layer pattern inspired by Bilawal Sidhu's WorldView demo: 3D world shell plus satellite, aircraft, webcam, seismic, traffic, and other public data streams.

_Avoid_: claiming parity with Google Earth, Palantir, or proprietary data fusion systems.

## Example dialogue

- User: "Show me what sources are live."
- App: "Sensor Fusion Deck shows 5/9 layers live, 8 tracked objects, and the reconstruction lane still planned."
