/**
 * Bus Announcer Bridge Service (Personnel App / Pi 4B)
 * Communicates with the local Pi 4B bridge (bridge.py) on port 5000 (or via /bridge dev proxy).
 *
 * Implemented strictly according to the "Pi 3B Interface for the Admin App (Pi 4B)" specification:
 * 1. Commands (4B -> 3B):
 *    - POST /api/trip/start with body { direction: 'Northbound' | 'Southbound' }
 *    - POST /api/trip/end with body {}
 *    - Direction must be exactly 'Northbound' or 'Southbound'
 *    - Replies: 200 ok; 400 bad direction; 409 already active; 403 network forbidden
 * 2. Status (4B -> 3B):
 *    - GET /api/state every 2 to 3 seconds. If fails/times out -> "Pi 3B Announcer Offline"
 * 3. GPS Stream (3B -> 4B):
 *    - GET /api/gps (backed by UDP 5005). Data older than 5 seconds is treated as "GPS lost"
 *    - Strictly consumes REAL GPS coordinates streamed from Pi 3B. No mock or auto-moving stops.
 */

/**
 * Determine the local bridge API base URL safely across Vite dev server and Firefox Kiosk production.
 */
export function getBridgeBaseUrl() {
  if (typeof window !== 'undefined' && window.__BRIDGE_URL__) {
    return window.__BRIDGE_URL__;
  }
  if (import.meta.env.VITE_BRIDGE_URL) {
    return import.meta.env.VITE_BRIDGE_URL;
  }
  if (import.meta.env.DEV) {
    return '/bridge';
  }
  const hostname = (typeof window !== 'undefined' && window.location && window.location.hostname)
    ? window.location.hostname
    : 'localhost';
  // The bridge runs on the same Pi 4B as the Firefox kiosk. Use loopback so
  // the HTTPS Vercel app talks to the local HTTP bridge, never directly to Pi 3B.
  return 'http://127.0.0.1:5000';
}

/**
 * Send Northbound or Southbound trip start command to the Pi 3B Bus Announcer.
 * Per spec: The direction must be exactly 'Northbound' or 'Southbound'.
 *
 * @param {'Northbound' | 'Southbound'} direction
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, success: boolean, direction?: string, pi3b_response?: any, conflict?: boolean, status?: number, error?: string }>}
 */
export async function sendTripStart(direction, options = {}) {
  const norm = String(direction || '').trim();
  if (norm !== 'Northbound' && norm !== 'Southbound') {
    return {
      ok: false,
      success: false,
      status: 400,
      error: `Direction must be exactly 'Northbound' or 'Southbound'. Received: '${direction}'`
    };
  }

  try {
    const response = await fetch(`${getBridgeBaseUrl()}/api/trip/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: norm,
        force: Boolean(options.force),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      return {
        ok: true,
        success: true,
        direction: data.direction || norm,
        pi3b_response: data.pi3b_response,
      };
    }

    if (response.status === 409) {
      return {
        ok: false,
        success: false,
        status: 409,
        conflict: true,
        alreadyRunning: true,
        error: data.error || 'A trip is already active on the Pi 3B announcer.',
        pi3b_response: data.pi3b_response,
      };
    }

    return {
      ok: false,
      success: false,
      status: response.status,
      error: data.error || `Bridge returned HTTP ${response.status}`,
      pi3b_response: data.pi3b_response,
    };
  } catch (err) {
    console.warn('[BusAnnouncerBridge] Could not send start trip to bridge:', err.message);
    return {
      ok: false,
      success: false,
      status: 502,
      error: 'Pi 3B Announcer Offline (Bridge unreachable)',
    };
  }
}

export const sendDirectionToBridge = sendTripStart;

/**
 * End or pause the current trip on the Pi 3B Bus Announcer (POST /api/trip/end {}).
 *
 * @returns {Promise<{ ok: boolean, success: boolean, error?: string, pi3b_response?: any }>}
 */
export async function sendTripEnd() {
  try {
    const response = await fetch(`${getBridgeBaseUrl()}/api/trip/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        ok: true,
        success: true,
        pi3b_response: data.pi3b_response
      };
    }

    return {
      ok: false,
      success: false,
      status: response.status,
      error: data.error || `Bridge returned HTTP ${response.status}`,
      pi3b_response: data.pi3b_response
    };
  } catch (err) {
    console.warn('[BusAnnouncerBridge] Could not send end trip to bridge:', err.message);
    return {
      ok: false,
      success: false,
      status: 502,
      error: 'Pi 3B Announcer Offline (Bridge unreachable)',
    };
  }
}

export const endTripOnBridge = sendTripEnd;

/**
 * Fetch raw status snapshot of the Pi 3B Announcer (GET /api/state).
 * Rule 2: GET /api/state every 2 to 3 seconds.
 * If it fails or times out, returns { online: false, error: 'Pi 3B Announcer Offline' }.
 *
 * Variables in reply from Pi 3B:
 * - active: true while a trip is running
 * - trip: "Northbound", "Southbound", or null
 * - trip_label: Route text e.g. "QC Hall Interchange -> SB Road"
 * - stops: List of stop names in order (15 stops)
 * - current_idx: Index of last stop reached (0 = first)
 * - idx: Index of stop the bus is heading to
 * - phase: idle, waiting, approaching, or at_stop
 * - dist: Meters to next stop or null
 * - trips_done: Number of completed trips
 * - last_trip: { direction, finished_at } or null
 * - gps: { fix: true/false, lat, lon, kmh }
 *
 * @returns {Promise<any>}
 */
export async function fetchAnnouncerState() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const response = await fetch(`${getBridgeBaseUrl()}/api/state`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { online: false, error: 'Pi 3B Announcer Offline' };
    }

    const data = await response.json();
    if (data.online === false || data.error) {
      return { online: false, error: data.error || 'Pi 3B Announcer Offline', ...data };
    }

    return { online: true, ...data };
  } catch {
    return { online: false, error: 'Pi 3B Announcer Offline' };
  }
}

/**
 * Fetch the latest REAL GPS fix received by Pi 4B from the Pi 3B GPS receiver over UDP 5005.
 * Rule 3: Treat data older than about 5 seconds as "GPS lost".
 * NO mock data or artificial moving stops. Strictly uses the live UDP stream from Pi 3B.
 *
 * @returns {Promise<{
 *   fix: boolean,
 *   lost: boolean,
 *   latitude: number | null,
 *   longitude: number | null,
 *   speed?: number | null,
 *   heading?: number | null,
 *   accuracy?: number,
 *   timestamp?: number,
 *   age_seconds?: number | null,
 *   status: 'active' | 'lost',
 *   error?: string
 * }>}
 */
export async function fetchLatestBridgeGps() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${getBridgeBaseUrl()}/api/gps`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        fix: false,
        lost: true,
        latitude: null,
        longitude: null,
        status: 'lost',
        error: 'Bridge offline'
      };
    }

    const envelope = await response.json();
    // bridge.py returns { data: <Pi 3B UDP packet>, age_seconds }, while the
    // in-repo pi4b_bridge.py returns the GPS fields at the top level.
    const data = envelope?.data && typeof envelope.data === 'object'
      ? { ...envelope.data, age_seconds: envelope.age_seconds }
      : envelope;
    const latitude = data.latitude ?? data.lat;
    const longitude = data.longitude ?? data.lon;
    const hasCoordinates = latitude != null && longitude != null
      && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
    const hasFreshPacket = data.age_seconds == null || Number(data.age_seconds) <= 5;
    const hasFix = data.fix === false || data.valid === false ? false : (data.fix === true || hasCoordinates);

    // Rule 3: Treat data older than about 5 seconds as "GPS lost"
    const isLost = Boolean(data.lost) || !hasFix || !hasFreshPacket || !hasCoordinates;

    if (!isLost) {
      return {
        fix: true,
        lost: false,
        latitude: Number(latitude),
        longitude: Number(longitude),
        timestamp: data.timestamp,
        speed: data.speed != null ? Number(data.speed) : null,
        heading: data.heading != null ? Number(data.heading) : null,
        accuracy: data.accuracy || 5,
        satellites: data.satellites != null ? Number(data.satellites) : null,
        altitude: data.altitude != null ? Number(data.altitude) : null,
        source: data.source || 'g703',
        port: data.port || null,
        age_seconds: data.age_seconds,
        status: 'active'
      };
    }

    return {
      fix: false,
      lost: true,
      latitude: null,
      longitude: null,
      timestamp: data.timestamp,
      speed: null,
      heading: null,
      satellites: data.satellites != null ? Number(data.satellites) : null,
      source: data.source,
      port: data.port,
      age_seconds: data.age_seconds,
      status: 'lost',
      error: 'GPS lost'
    };
  } catch (err) {
    return {
      fix: false,
      lost: true,
      latitude: null,
      longitude: null,
      status: 'lost',
      error: err.message || 'GPS lost'
    };
  }
}

/**
 * Fetch overall status of the Pi 4B bridge and the Pi 3B Bus Announcer.
 *
 * @returns {Promise<{ success: boolean, bridge?: any, latest_gps?: any, pi3b?: any, online: boolean, error?: string }>}
 */
export async function fetchBridgeStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${getBridgeBaseUrl()}/api/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        online: false,
        error: data.error || `Bridge returned HTTP ${response.status}`,
      };
    }

    const isOnline = Boolean(data.pi3b_online ?? (data.pi3b && !data.pi3b.error && data.pi3b.online !== false));

    return {
      success: true,
      bridge: data.bridge,
      latest_gps: data.latest_gps,
      pi3b: data.pi3b,
      online: isOnline,
    };
  } catch (err) {
    return {
      success: false,
      online: false,
      error: err.message || 'Bridge unreachable',
    };
  }
}
