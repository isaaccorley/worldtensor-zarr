import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device } from "@luma.gl/core";
import maplibregl from "maplibre-gl";

const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
const LABELS = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Green-tinted monochrome basemap: near-black water and land, hairline borders. */
function styleBasemap(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#141a19");
    if (layer.type === "fill" && /water/.test(layer.id)) {
      map.setPaintProperty(layer.id, "fill-color", "#090d0d");
    }
    if (layer.type === "fill" && /land(cover|use)|park|building/.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
    if (layer.type === "line" && /boundary|admin/.test(layer.id)) {
      map.setPaintProperty(layer.id, "line-color", "rgba(230,246,231,0.32)");
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
        // mint rim light, after Earthscale's globe
        "sky-color": "#0b0f0f",
        "horizon-color": "#4fbf98",
        "fog-color": "#0b0f0f",
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
          map.setPaintProperty(layer.id, "text-color", "rgba(230,246,231,0.74)");
          map.setPaintProperty(layer.id, "text-halo-color", "rgba(9,13,13,0.85)");
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
          "line-color": "#e6f6e7",
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

/**
 * Soft mint halo behind the globe (Earthscale-style), sized from the globe's
 * on-screen radius. The map canvas is transparent off-globe, so a div under it shows.
 */
export function globeGlow(map: maplibregl.Map, el: HTMLElement, caption?: HTMLElement) {
  const place = () => {
    const c = map.getCenter();
    const lat = Math.max(-80, Math.min(80, c.lat));
    // a point 80 degrees along the meridian sits near the limb: d ~ r sin(80)
    const p0 = map.project([c.lng, lat]);
    const p1 = map.project([c.lng, lat > 0 ? lat - 80 : lat + 80]);
    const r = Math.hypot(p1.x - p0.x, p1.y - p0.y) / Math.sin((80 * Math.PI) / 180);
    const zoom = map.getZoom();
    el.style.setProperty("--r", `${r}px`);
    el.style.opacity = String(Math.max(0, Math.min(1, 4.5 - zoom)));
    // the big title steps aside once you zoom in to read the data
    if (caption) caption.style.opacity = String(Math.max(0, Math.min(1, 3.6 - zoom)));
    const cv = map.getCanvas().getBoundingClientRect();
    const host = el.parentElement!.getBoundingClientRect();
    el.style.left = `${cv.left - host.left + cv.width / 2}px`;
    el.style.top = `${cv.top - host.top + cv.height / 2}px`;
  };
  map.on("move", place);
  map.on("resize", place);
  place();
}
