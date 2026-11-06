import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device } from "@luma.gl/core";
import maplibregl from "maplibre-gl";

const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
const LABELS = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Warm the carto dark basemap toward the espresso palette. */
function warmBasemap(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#17120e");
    if (layer.type === "fill" && /water/.test(layer.id)) {
      map.setPaintProperty(layer.id, "fill-color", "#0f0c09");
    }
    if (layer.type === "fill" && /land(cover|use)|park|building/.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
    if (layer.type === "line" && /boundary|admin/.test(layer.id)) {
      map.setPaintProperty(layer.id, "line-color", "rgba(243,236,216,0.35)");
    }
  }
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
    attributionControl: { compact: true },
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
      warmBasemap(map);
      // pull label layers from the full style and stack them above the raster
      let beforeId: string | undefined;
      try {
        const labels = await (await fetch(LABELS)).json();
        for (const [id, src] of Object.entries(labels.sources)) {
          if (!map.getSource(id)) map.addSource(id, src as maplibregl.SourceSpecification);
        }
        if (labels.glyphs) map.setGlyphs(labels.glyphs);
        for (const layer of labels.layers) {
          if (layer.type !== "symbol" || !/place|country|continent/.test(layer.id)) continue;
          if (map.getLayer(layer.id)) continue;
          map.addLayer(layer);
          map.setPaintProperty(layer.id, "text-color", "rgba(243,236,216,0.82)");
          map.setPaintProperty(layer.id, "text-halo-color", "rgba(14,11,8,0.75)");
          map.setPaintProperty(layer.id, "text-halo-width", 1.2);
          beforeId ??= layer.id;
        }
      } catch {
        // labels are decoration; render without them
      }
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
