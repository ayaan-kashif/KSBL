'use client';

import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import type { HeatmapCluster } from '@/lib/api';
import styles from './HotspotMap.module.css';

/**
 * Viewport default ONLY — this is not data and never renders as a point.
 * Leaflet requires a centre to initialise, so when the endpoint returns zero
 * located clusters there is nothing to fit bounds to and the map has to open
 * somewhere. Karachi is the product's primary market. The moment any located
 * cluster arrives, fitBounds overrides this entirely.
 */
const DEFAULT_CENTER: [number, number] = [24.8607, 67.0011];
const DEFAULT_ZOOM = 11;

/** A cluster the API gave real coordinates for. */
type LocatedCluster = HeatmapCluster & { latitude: number; longitude: number };

/** Narrows out clusters the API could not geocode — they stay in the list, not the map. */
function isLocated(c: HeatmapCluster): c is LocatedCluster {
  return typeof c.latitude === 'number' && typeof c.longitude === 'number';
}

export interface MapFocus {
  lat: number;
  lng: number;
  /** Bumped on every click so re-selecting the same row re-triggers the fly-to. */
  nonce: number;
}

interface HotspotMapProps {
  clusters: HeatmapCluster[];
  loading: boolean;
  focus?: MapFocus | null;
}

/**
 * Leaflet's default marker points at bundler-relative URLs that Next's asset
 * pipeline rewrites, leaving broken images. Deleting the resolver and pinning
 * absolute paths is the standard fix.
 *
 * Nothing here uses L.Marker today — the heat layer and circleMarkers cover the
 * current design — but this runs once and costs nothing, so adding a marker
 * later cannot reintroduce the bug. Icons live in /public (see README note).
 */
let iconsPatched = false;
function patchDefaultIcon() {
  if (iconsPatched) return;
  iconsPatched = true;
  // Cast rather than `any`: _getIconUrl is a private Leaflet field with no type.
  delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl: '/leaflet/marker-icon.png',
    iconRetinaUrl: '/leaflet/marker-icon-2x.png',
    shadowUrl: '/leaflet/marker-shadow.png',
  });
}

/** Reads a design token off :root so the map follows globals.css, not a copy of it. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Builds popup DOM instead of an HTML string — area_name is data, never markup. */
function buildPopup(c: LocatedCluster): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = styles.popup;

  const title = document.createElement('p');
  title.className = styles.popupTitle;
  title.textContent = c.area_name;
  wrap.appendChild(title);

  const rows: Array<[string, string]> = [
    ['Scans', c.report_count.toLocaleString()],
    ['Suspicious', c.suspicious_count.toLocaleString()],
    ['Suspicious rate', `${c.suspicious_rate}%`],
  ];

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = styles.popupRow;

    const k = document.createElement('span');
    k.className = styles.popupKey;
    k.textContent = label;

    const v = document.createElement('span');
    v.className = styles.popupValue;
    v.textContent = value;

    row.append(k, v);
    wrap.appendChild(row);
  }

  return wrap;
}

/**
 * Owns every imperative Leaflet layer.
 *
 * leaflet.heat has no React binding, so the heat layer and the circleMarkers are
 * created directly against the map instance from useMap(). The whole set is torn
 * down and rebuilt whenever `clusters` changes — without that, the dashboard's
 * 45s auto-refresh and each brand-filter change would stack a new heat layer on
 * top of the previous ones and the map would darken on every poll.
 */
function HeatLayers({ clusters }: { clusters: HeatmapCluster[] }) {
  const map = useMap();

  const located = useMemo(() => clusters.filter(isLocated), [clusters]);

  /**
   * Signature of WHERE the clusters are, ignoring their counts.
   *
   * Layers rebuild on every poll because counts drive heat intensity, but
   * fitBounds must not: re-fitting every 45s would snatch the viewport back
   * from anyone who had panned, zoomed, or clicked a legend row. Positions
   * change only when areas appear/disappear or the brand filter changes, which
   * are exactly the moments a re-fit is wanted.
   */
  const boundsKey = useMemo(
    () => located.map((c) => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`).sort().join('|'),
    [located],
  );
  const lastBoundsKey = useRef<string | null>(null);

  useEffect(() => {
    if (located.length === 0) {
      // No located clusters: fall back to the neutral default view rather than
      // inventing a position. Nothing is drawn.
      if (lastBoundsKey.current !== '') {
        lastBoundsKey.current = '';
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      }
      return;
    }

    // Weight by counterfeit signal, not raw scan volume — the same basis the
    // API already ranks clusters on, so the map and the list agree.
    const maxSuspicious = Math.max(...located.map((c) => c.suspicious_count));
    const maxReports = Math.max(...located.map((c) => c.report_count), 1);

    const points: L.HeatLatLngTuple[] = located.map((c) => {
      // maxSuspicious === 0 means no counterfeits anywhere yet. Every point then
      // sits at the floor, which still shows where scanning is happening rather
      // than dividing by zero and rendering nothing.
      const ratio = maxSuspicious > 0 ? c.suspicious_count / maxSuspicious : 0;
      const intensity = Math.max(0.15, ratio); // floor keeps low areas visible
      return [c.latitude, c.longitude, intensity];
    });

    const heat = L.heatLayer(points, {
      radius: 30,
      blur: 20,
      maxZoom: 14,
      gradient: {
        0.15: token('--verdict-genuine-vivid', '#10b981'),
        0.55: token('--verdict-suspicious-vivid', '#f59e0b'),
        1.0: token('--verdict-counterfeit-vivid', '#f43f5e'),
      },
    }).addTo(map);

    const genuine = token('--verdict-genuine-vivid', '#10b981');
    const suspicious = token('--verdict-suspicious-vivid', '#f59e0b');
    const counterfeit = token('--verdict-counterfeit-vivid', '#f43f5e');

    const markers = located.map((c) => {
      // Area colour follows its own suspicious RATE, so a small area with a high
      // proportion of fakes still reads as hot.
      const colour =
        c.suspicious_rate >= 50 ? counterfeit : c.suspicious_rate > 0 ? suspicious : genuine;

      // sqrt so one very busy area cannot swamp the rest of the map.
      const radius = 6 + 12 * Math.sqrt(c.report_count / maxReports);

      return L.circleMarker([c.latitude, c.longitude], {
        radius,
        color: colour,
        weight: 2,
        fillColor: colour,
        fillOpacity: 0.35,
      })
        .bindPopup(buildPopup(c))
        .addTo(map);
    });

    // Only re-fit when the set of positions actually changed — see boundsKey.
    if (lastBoundsKey.current !== boundsKey) {
      lastBoundsKey.current = boundsKey;
      map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => [lat, lng] as [number, number])), {
        padding: [40, 40],
        maxZoom: 13,
      });
    }

    return () => {
      map.removeLayer(heat);
      markers.forEach((m) => map.removeLayer(m));
    };
  }, [located, boundsKey, map]);

  return null;
}

/** Pans to the cluster the user picked in the ranked list. */
function FocusController({ focus }: { focus?: MapFocus | null }) {
  const map = useMap();

  useEffect(() => {
    if (!focus) return;
    map.flyTo([focus.lat, focus.lng], 14, { duration: 0.6 });
    // nonce is in the deps so clicking the same row twice pans again.
  }, [focus, map]);

  return null;
}

/**
 * Leaflet measures its container on init. If the card is laid out after that —
 * the analytics grid reflows at 900px — the map keeps its stale size and tiles
 * render into the wrong box. A ResizeObserver re-measures instead.
 */
function ResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);

  return null;
}

export default function HotspotMap({ clusters, loading, focus }: HotspotMapProps) {
  patchDefaultIcon();

  const locatedCount = useMemo(() => clusters.filter(isLocated).length, [clusters]);

  return (
    <div className={styles.wrap}>
      {/* The map stays mounted across refreshes — unmounting it would re-init
          Leaflet and refetch every tile on each 45s poll. */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom={false}
        className={styles.map}
        aria-label="Map of counterfeit hotspots by area"
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <HeatLayers clusters={clusters} />
        <FocusController focus={focus} />
        <ResizeHandler />
      </MapContainer>

      {loading && (
        <div className={styles.overlay}>
          <span className="material-symbols-outlined" aria-hidden="true">sync</span>
          <span className={styles.overlayLabel}>UPDATING MAP…</span>
        </div>
      )}

      {/* Distinct from "loading": the request finished and genuinely had no
          located clusters. No fallback points are drawn. `loading` starts true
          on the analytics page, so !loading already means "a fetch settled" —
          no extra first-render guard is needed. */}
      {!loading && locatedCount === 0 && (
        <div className={styles.empty} role="status">
          <span className="material-symbols-outlined" aria-hidden="true">location_off</span>
          <p className={styles.emptyTitle}>No mapped hotspots yet</p>
          <p className={styles.emptyBody}>
            Scans appear here once they are captured with location permission granted.
          </p>
        </div>
      )}
    </div>
  );
}
