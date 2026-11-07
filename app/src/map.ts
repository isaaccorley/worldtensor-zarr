import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device } from "@luma.gl/core";
import maplibregl from "maplibre-gl";

const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
const LABELS = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Monochrome basemap: black water, near-black land, hairline borders. */
function styleBasemap(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#151515");
    if (layer.type === "fill" && /water/.test(layer.id)) {
      map.setPaintProperty(layer.id, "fill-color", "#0a0a0a");
    }
    if (layer.type === "fill" && /land(cover|use)|park|building/.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
    if (layer.type === "line" && /boundary|admin/.test(layer.id)) {
      map.setPaintProperty(layer.id, "line-color", "rgba(255,255,255,0.32)");
    }
  }
}

/** 15-degree graticule as GeoJSON lines (drawn above the raster, very faint). */
function graticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon <= 180; lon += 15) {
    const coords: [number, number][] = [];
    for (let lat = -90; lat <= 90; lat += 2) coords.push([lon, lat]);
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const coords: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: { equator: lat === 0 },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

export type MapHandles = {
  map: maplibregl.Map;
  overlay: MapboxOverlay;
  /** id of the first basemap layer drawn above the raster (borders + labels) */
  beforeId: string | undefined;
};

export function createMap(
  container: HTMLElement,
  view: { center: [number, number]; zoom: number },
  onDevice: (d: Device) => void,
): Promise<MapHandles> {
  const map = new maplibregl.Map({
    container,
    style: STYLE,
    center: view.center,
    zoom: view.zoom,
    attributionControl: new URLSearchParams(location.search).has("clean") ? false : { compact: true },
    maxPitch: 0,
  });
  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: [],
    deviceProps: { _reuseDevices: true },
    onDeviceInitialized: onDevice,
  });
  map.addControl(overlay);

  return new Promise((resolve) => {
    map.once("style.load", async () => {
      map.setProjection({ type: "globe" });
      styleBasemap(map);
      // atmosphere halo around the globe, fading out as you zoom in
      map.setSky({
        "sky-color": "#000000",
        "horizon-color": "#1a1a1a",
        "fog-color": "#000000",
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
      });
      // pull label layers from the full style and stack them above the raster
      // (`?clean` skips them: used to render the social preview image)
      let beforeId: string | undefined;
      try {
        if (new URLSearchParams(location.search).has("clean")) throw new Error("clean");
        const labels = await (await fetch(LABELS)).json();
        for (const [id, src] of Object.entries(labels.sources)) {
          if (!map.getSource(id)) map.addSource(id, src as maplibregl.SourceSpecification);
        }
        if (labels.glyphs) map.setGlyphs(labels.glyphs);
        for (const layer of labels.layers) {
          if (layer.type !== "symbol" || !/place|country|continent/.test(layer.id)) continue;
          if (map.getLayer(layer.id)) continue;
          map.addLayer(layer);
          map.setPaintProperty(layer.id, "text-color", "rgba(237,237,237,0.72)");
          map.setPaintProperty(layer.id, "text-halo-color", "rgba(0,0,0,0.85)");
          map.setPaintProperty(layer.id, "text-halo-width", 1);
          beforeId ??= layer.id;
        }
      } catch {
        // labels are decoration; render without them
      }
      map.addSource("graticule", { type: "geojson", data: graticule() });
      map.addLayer({
        id: "graticule",
        type: "line",
        source: "graticule",
        paint: {
          "line-color": "#ffffff",
          "line-opacity": ["case", ["==", ["get", "equator"], true], 0.38, 0.2],
          "line-width": 0.7,
        },
      });
      // country borders sit above the raster; carto puts county/state
      // boundaries *below* water, so anchor on the country outline explicitly
      const anchor = map.getLayer("boundary_country_outline") ? "boundary_country_outline" : beforeId;
      resolve({ map, overlay, beforeId: anchor });
    });
  });
}

/** A pulsing ring marking the inspected pixel. */
export function pinMarker(map: maplibregl.Map) {
  const el = document.createElement("div");
  el.className = "pin";
  el.innerHTML = '<span class="pin-core"></span><span class="pin-ring"></span>';
  const marker = new maplibregl.Marker({ element: el });
  return {
    show(lng: number, lat: number) {
      marker.setLngLat([lng, lat]).addTo(map);
    },
    hide() {
      marker.remove();
    },
  };
}
