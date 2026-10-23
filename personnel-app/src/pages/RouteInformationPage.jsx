/**
 * RouteInformationPage Component (React / JSX)
 * Bus Admin / Conductor live route information dashboard featuring:
 * - Direction-dependent stop arrangement with Northbound/Southbound controls
 * - Real-time seat availability (/20 Priority vs /30 Regular)
 * - Live USB/RS232-TTL QR scanner integration assessing category & updating stop passenger counts
 * - Per-stop boarded & alighting counters across all 15 Route 4 stops
 * - Automatic GPS arrival detection triggering manual registration
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchConfiguredRoute4Stops,
  fetchOngoingTripForBus,
  fetchPassengerRegistry,
  createManualPassengerJourney,
  recordBoardingEvent,
  fetchJourneyByQrToken,
  publishCurrentBusLocation,
  startDutyTripForBus,
  startNextTrip,
  supabase
} from '../services/supabaseClient';
import {
  sendTripStart,
  sendTripEnd,
  sendDirectionToBridge,
  endTripOnBridge,
  fetchBridgeStatus,
  fetchLatestBridgeGps,
  fetchAnnouncerState
} from '../services/busAnnouncerBridge';
import { ROUTE4_STOPS, SOUTHBOUND_ROUTE4_STOPS, applyRoute4CoordinateOverrides, resolveRoute4Stop, validateTripDirection, detectPassengerDirection, getStopIndex } from '@shared/route4Stops';
import { getStopRecommendedBoarding } from '@shared/queueAndBoardingService';
import { parsePassengerQRCode, isPriorityCategory, hasPriorityInParty } from '@shared/qrPassUtils';
import { QrCameraScannerModal } from '../components/QrCameraScannerModal';

export function RouteInformationPage() {
  const { dutySession, updateDutySession, isTestMode } = useAuth();
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  // Current Live Time & Date Today (Hours and Minutes ONLY)
  const [currentTime, setCurrentTime] = useState(new Date());

  // Direction State (Northbound vs Southbound)
  const [direction, setDirection] = useState(dutySession?.tripDirection || 'Northbound');
  const [routeStops, setRouteStops] = useState(ROUTE4_STOPS);

  // Dynamic Stops list according to direction
  const [stopsList, setStopsList] = useState(direction === 'Southbound' ? SOUTHBOUND_ROUTE4_STOPS : routeStops);

  // Current stop index & Trip movement state
  const [currentStopIndex, setCurrentStopIndex] = useState(0);
  const [headingStopIndex, setHeadingStopIndex] = useState(1);
  const [isTripActive, setIsTripActive] = useState(false);
  const [tripCount, setTripCount] = useState(1);
  const [statusMessage, setStatusMessage] = useState(null);
  const [statusType, setStatusType] = useState('success');

  const testRegistryKey = `qcbus_test_registry_${dutySession?.tripId || 'local'}_${new Date().toISOString().slice(0, 10)}`;
  const tripSegmentKey = `${testRegistryKey}_started_at`;
  const [tripSegmentStartedAt, setTripSegmentStartedAt] = useState(() => Number(localStorage.getItem(tripSegmentKey)) || 0);
  const [passengerRegistry, setPassengerRegistry] = useState(() => {
    try {
      const plate = dutySession?.plateNumber || 'QC-BUS';
      const key = isTestMode ? testRegistryKey : `qcbus_registry_${plate}`;
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [operationalTripId, setOperationalTripId] = useState(null);

  // Real-time Vehicle Device Geolocation State (from G-703 USB receiver on Pi 4B)
  const [deviceGps, setDeviceGps] = useState({
    active: false,
    latitude: null,
    longitude: null,
    accuracy: null,
    speed: null,
    heading: null,
    satellites: null,
    altitude: null,
    error: null,
    lastUpdated: null,
    source: null,
    port: null
  });

  // GPS Matching & Stop Progression State
  const [stopDistances, setStopDistances] = useState({});
  const [distanceToHeading, setDistanceToHeading] = useState(null);
  const [tripPhase, setTripPhase] = useState('idle'); // 'idle' | 'waiting' | 'in_transit' | 'approaching' | 'at_stop' | 'completed'

  // Pi 3B Bus Announcer Connection & State (Rule 2: GET /api/state every 2 to 3 seconds)
  const [announcerInfo, setAnnouncerInfo] = useState({
    online: false,
    checking: true,
    lastCheck: null,
    state: null
  });

  // Manual Registration State
  const [showManualRegistration, setShowManualRegistration] = useState(false);
  const [manualPassengerCategory, setManualPassengerCategory] = useState('Regular');
  const [manualPassengerCount, setManualPassengerCount] = useState(1);
  const [manualDestination, setManualDestination] = useState('');
  const [manualRegistrationBusy, setManualRegistrationBusy] = useState(false);
  const manualSubmissionRef = useRef(false);
  const lastTripsDoneRef = useRef(null);

  const scannerBufferRef = useRef('');
  const scannerResetTimerRef = useRef(null);

  // Clock Poller
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Pi 3B State Poller (Rule 2)
  useEffect(() => {
    let active = true;
    const pollState = async () => {
      const state = await fetchAnnouncerState();
      if (!active) return;

      if (!state || state.online === false || state.error) {
        setAnnouncerInfo(prev => ({
          ...prev,
          online: false,
          checking: false,
          lastCheck: Date.now(),
          state: null
        }));
        return;
      }

      setAnnouncerInfo({
        online: true,
        checking: false,
        lastCheck: Date.now(),
        state
      });

      // Synchronize stop indexes per Rule 5
      if (typeof state.current_idx === 'number' && state.current_idx >= 0) {
        setCurrentStopIndex(state.current_idx);
      }
      if (typeof state.idx === 'number' && state.idx >= 0) {
        setHeadingStopIndex(state.idx);
      }

      // Rule 5: Trip ended automatically when trips_done increments and active becomes false
      if (
        isTripActive &&
        state.active === false &&
        typeof state.trips_done === 'number' &&
        typeof lastTripsDoneRef.current === 'number' &&
        state.trips_done > lastTripsDoneRef.current
      ) {
        setIsTripActive(false);
        setStatusMessage('Trip completed! Pi 3B Announcer reached final terminus stop.');
      }
    };

    pollState();
    const timer = setInterval(pollState, 2500); // Poll every 2.5 seconds (per Rule 2)
    return () => { active = false; clearInterval(timer); };
  }, [isTripActive]);

  // Stops Initializer
  useEffect(() => {
    let mounted = true;
    fetchConfiguredRoute4Stops().then((result) => {
      if (mounted && result.success && result.data.length) {
        setRouteStops(result.data.slice(0, 15));
      }
    });
    return () => { mounted = false; };
  }, []);

  // Ordered Stops List
  useEffect(() => {
    let base = routeStops;
    if (direction === 'Southbound') {
      base = [...routeStops]
        .reverse()
        .filter((s) => {
          const n = s.name.toLowerCase();
          return !(n.includes('quirino') && n.includes('mindanao'));
        })
        .map((s) => {
          if (s.name.toLowerCase().includes('bayan') || s.name.toLowerCase().includes('nova')) {
            return { ...s, lat: 14.721004296116766, lng: 121.03876650768528 };
          }
          return s;
        });
    }
    const orderedStops = applyRoute4CoordinateOverrides(base, direction);
    setStopsList(orderedStops.map((stop, idx) => ({
      ...stop,
      stopNumber: idx + 1,
      id: direction === 'Southbound' ? `sb-stop-${idx + 1}` : `stop-${idx + 1}`
    })));
  }, [direction, routeStops]);

  useEffect(() => {
    let cancelled = false;
    const refreshRegistry = async () => {
      let tripId = null;
      if (dutySession.plateNumber) {
        const trip = await fetchOngoingTripForBus(dutySession.plateNumber);
        tripId = trip.success ? trip.data?.id : null;
      }
      if (!tripId) {
        if (!cancelled && !isTripActive && !dutySession.tripId) {
          setOperationalTripId(null);
        }
        return;
      }
      const result = await fetchPassengerRegistry(tripId);
      if (!cancelled && result.success) {
        setOperationalTripId(tripId);
        setPassengerRegistry((prevRows) => {
          const dbRows = result.data || [];
          const statusRank = (status) => {
            const s = String(status || '').toLowerCase();
            if (s === 'completed' || s === 'alighted' || s === 'done') return 3;
            if (s === 'boarded' || s === 'onboard' || s === 'active') return 2;
            return 1;
          };

          const prevById = new Map();
          const prevByToken = new Map();
          (prevRows || []).forEach((row) => {
            if (row.id) prevById.set(String(row.id), row);
            if (row.qr_token) prevByToken.set(String(row.qr_token), row);
          });

          const mergedIds = new Set();
          const mergedTokens = new Set();

          const combined = dbRows.map((dbRow) => {
            const rowId = dbRow.id ? String(dbRow.id) : null;
            const rowToken = dbRow.qr_token ? String(dbRow.qr_token) : null;
            const localMatch = (rowId && prevById.get(rowId)) || (rowToken && prevByToken.get(rowToken));

            if (rowId) mergedIds.add(rowId);
            if (rowToken) mergedTokens.add(rowToken);

            if (localMatch) {
              const localRank = statusRank(localMatch.status);
              const dbRank = statusRank(dbRow.status);
              // If local state is further along (e.g. boarded > planned, or completed > boarded),
              // preserve the local status, timestamps, and resolved stop names
              if (localRank > dbRank) {
                return {
                  ...dbRow,
                  ...localMatch,
                  id: dbRow.id || localMatch.id,
                  trip_id: dbRow.trip_id || localMatch.trip_id,
                  status: localMatch.status,
                  boarded_at: localMatch.boarded_at || dbRow.boarded_at,
                  alighted_at: localMatch.alighted_at || dbRow.alighted_at,
                  origin_name: localMatch.origin_name || dbRow.origin_name,
                  destination_name: localMatch.destination_name || dbRow.destination_name,
                  count: localMatch.count || Math.max(1, Number(dbRow.passenger_count) || 1)
                };
              }
              return {
                ...localMatch,
                ...dbRow,
                count: Math.max(1, Number(dbRow.count || dbRow.passenger_count || localMatch.count) || 1),
                origin_name: localMatch.origin_name || dbRow.origin_name,
                destination_name: localMatch.destination_name || dbRow.destination_name
              };
            }
            return {
              ...dbRow,
              count: Math.max(1, Number(dbRow.count || dbRow.passenger_count) || 1)
            };
          });

          // Add any local-only entries that were not present in dbRows
          (prevRows || []).forEach((row) => {
            const rId = row.id ? String(row.id) : null;
            const rToken = row.qr_token ? String(row.qr_token) : null;
            const inDb = (rId && mergedIds.has(rId)) || (rToken && mergedTokens.has(rToken));
            if (!inDb) {
              combined.push(row);
            }
          });

          try {
            const plate = dutySession?.plateNumber || 'QC-BUS';
            const key = isTestMode ? testRegistryKey : `qcbus_registry_${plate}`;
            localStorage.setItem(key, JSON.stringify(combined));
          } catch (_) {}
          return combined;
        });
      }
    };
    refreshRegistry();
    const timer = setInterval(refreshRegistry, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [dutySession?.tripId, dutySession?.plateNumber, operationalTripId, isTestMode, tripSegmentStartedAt, isTripActive, testRegistryKey]);

  const saveAndSyncRegistry = useCallback((nextRegistry) => {
    try {
      const plate = dutySession?.plateNumber || 'QC-BUS';
      localStorage.setItem(`qcbus_registry_${plate}`, JSON.stringify(nextRegistry));
      if (isTestMode && testRegistryKey) {
        localStorage.setItem(testRegistryKey, JSON.stringify(nextRegistry));
      }
      window.dispatchEvent(new CustomEvent('qcbus_registry_sync', { detail: { plate, rows: nextRegistry } }));
    } catch (_) {}
  }, [dutySession?.plateNumber, isTestMode, testRegistryKey]);

  useEffect(() => {
    saveAndSyncRegistry(passengerRegistry);
  }, [passengerRegistry, saveAndSyncRegistry]);

  useEffect(() => {
    const handleSync = () => {
      try {
        const plate = dutySession?.plateNumber || 'QC-BUS';
        const saved = localStorage.getItem(`qcbus_registry_${plate}`) || (isTestMode ? localStorage.getItem(testRegistryKey) : null);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setPassengerRegistry((prev) => {
              if (JSON.stringify(prev) === saved) return prev;
              return parsed;
            });
          }
        }
      } catch (_) {}
    };
    window.addEventListener('qcbus_registry_sync', handleSync);
    window.addEventListener('storage', handleSync);
    window.addEventListener('focus', handleSync);
    return () => {
      window.removeEventListener('qcbus_registry_sync', handleSync);
      window.removeEventListener('storage', handleSync);
      window.removeEventListener('focus', handleSync);
    };
  }, [dutySession?.plateNumber, isTestMode, testRegistryKey]);

  const currentStop = stopsList[currentStopIndex] || stopsList[0];
  const normalizeStopName = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Robust stop equality matching canonical names, IDs, and normalized text
  const isSameStop = (a, b) => {
    if (!a || !b) return false;
    const strA = String(a?.name || a).trim();
    const strB = String(b?.name || b).trim();
    if (strA.toLowerCase() === strB.toLowerCase()) return true;
    const canonA = resolveRoute4Stop(strA, direction);
    const canonB = resolveRoute4Stop(strB, direction);
    if (canonA && canonB && canonA.name.toLowerCase() === canonB.name.toLowerCase()) return true;
    return normalizeStopName(strA) === normalizeStopName(strB);
  };

  // Direction isolation helper to prevent Northbound stop counts carrying over to Southbound
  const isJourneyMatchingDirection = (journey, activeDir) => {
    if (!journey) return false;
    const target = String(activeDir || direction || 'Northbound').toLowerCase();
    const jDir = journey.direction || journey.route_direction || journey.routeDirection || journey.trip_direction;
    if (jDir) {
      return String(jDir).toLowerCase() === target;
    }
    if (journey.origin_name && journey.destination_name) {
      const inferred = detectPassengerDirection(journey.origin_name, journey.destination_name);
      if (inferred) return inferred.toLowerCase() === target;
    }
    return target === 'northbound';
  };

  // Calculate Priority vs Regular Seat Quotas (20 Priority, 30 Regular = 50 total) for current direction
  const priorityBoarded = passengerRegistry.filter((journey) => journey.status === 'boarded' && isJourneyMatchingDirection(journey, direction)).reduce((acc, curr) => {
    if (curr.priority_count != null) return acc + Number(curr.priority_count);
    const isPri = isPriorityCategory(curr.passenger_category || curr.profiles?.passenger_category || curr.category);
    return acc + (isPri ? (Number(curr.count) || 1) : 0);
  }, 0);

  const regularBoarded = passengerRegistry.filter((journey) => journey.status === 'boarded' && isJourneyMatchingDirection(journey, direction)).reduce((acc, curr) => {
    if (curr.regular_count != null) return acc + Number(curr.regular_count);
    const isPri = isPriorityCategory(curr.passenger_category || curr.profiles?.passenger_category || curr.category);
    return acc + (!isPri ? (Number(curr.count) || 1) : 0);
  }, 0);

  const busCapacity = Number(dutySession?.busCapacity) || 50;
  const prioritySeatCapacity = Math.min(20, busCapacity);
  const regularSeatCapacity = Math.max(0, busCapacity - prioritySeatCapacity);
  const availablePrioritySeats = Math.max(0, prioritySeatCapacity - priorityBoarded);
  const availableRegularSeats = Math.max(0, regularSeatCapacity - regularBoarded);
  const totalOnboard = priorityBoarded + regularBoarded;

  // Boarded & Alighting counters per stop using canonical stop resolution (direction-isolated)
  const passengersBoardedAt = (stopName) => {
    return passengerRegistry.filter((journey) => {
      const isBoardedOrDone = journey.status === 'boarded' || journey.status === 'completed';
      return isBoardedOrDone && isJourneyMatchingDirection(journey, direction) && isSameStop(journey.origin_name, stopName);
    }).reduce((acc, curr) => acc + (Number(curr.count) || 1), 0);
  };

  const passengersAlightingAt = (stopName) => {
    return passengerRegistry.filter((journey) => {
      const isCurrentlyBoarded = journey.status === 'boarded';
      return isCurrentlyBoarded && isJourneyMatchingDirection(journey, direction) && isSameStop(journey.destination_name, stopName);
    }).reduce((acc, curr) => acc + (Number(curr.count) || 1), 0);
  };

  const passengersCompletedAlightedAt = (stopName) => {
    return passengerRegistry.filter((journey) => {
      const isCompleted = journey.status === 'completed';
      return isCompleted && isJourneyMatchingDirection(journey, direction) && isSameStop(journey.destination_name, stopName);
    }).reduce((acc, curr) => acc + (Number(curr.count) || 1), 0);
  };

  // Match GPS fixes against every stop so missed or out-of-order arrivals can recover.
  const lastTriggeredStopRef = useRef(null);
  const busIdRef = useRef(null);
  const ARRIVAL_RADIUS_METERS = 40; // 40-meter radius trigger for realistic GPS stop arrival
  const APPROACH_RADIUS_METERS = 140; // 140-meter radius for "approaching stop" detection
  const DEPARTURE_RADIUS_METERS = 50; // 50-meter departure threshold from current stop

  const calculateDistanceMeters = (lat1, lon1, lat2, lon2) => {
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return Infinity;
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const ensureOperationalTrip = async () => {
    if (dutySession.plateNumber) {
      const ongoing = await fetchOngoingTripForBus(dutySession.plateNumber);
      if (ongoing.success && ongoing.data?.id) {
        setOperationalTripId(ongoing.data.id);
        return ongoing.data.id;
      }
    }

    const started = await startDutyTripForBus({
      plateNumber: dutySession.plateNumber,
      busCapacity: dutySession.busCapacity || 50,
      driverPersonnelId: dutySession.driverPersonnelId,
      conductorPersonnelId: dutySession.conductorPersonnelId,
      dispatcherPersonnelId: dutySession.dispatcherPersonnelId
    });
    if (!started.success || !started.data?.trip?.id) {
      throw new Error(started.error || 'Unable to start an ongoing database trip.');
    }
    const tripId = started.data.trip.id;
    setOperationalTripId(tripId);
    updateDutySession({ tripId });
    return tripId;
  };

  const resolveBusId = async () => {
    if (busIdRef.current) return busIdRef.current;
    const plate = dutySession.plateNumber || 'QC-BUS-0402';

    // 1. Check ongoing trip
    try {
      const ongoing = await fetchOngoingTripForBus(plate);
      if (ongoing.success && ongoing.data?.bus_id) {
        busIdRef.current = ongoing.data.bus_id;
        if (ongoing.data.id && !operationalTripId) {
          setOperationalTripId(ongoing.data.id);
        }
        return ongoing.data.bus_id;
      }
    } catch (_) {}

    // 2. Check bus by plate number
    try {
      const { data: bus } = await supabase.from('buses')
        .select('id').eq('plate_number', plate).maybeSingle();
      if (bus?.id) {
        busIdRef.current = bus.id;
        return bus.id;
      }
    } catch (_) {}

    // 3. Ensure duty trip is started for bus
    try {
      const started = await startDutyTripForBus({
        plateNumber: plate,
        busCapacity: dutySession.busCapacity || 50,
        driverPersonnelId: dutySession.driverPersonnelId,
        conductorPersonnelId: dutySession.conductorPersonnelId,
        dispatcherPersonnelId: dutySession.dispatcherPersonnelId
      });
      if (started.success && started.data?.bus?.id) {
        busIdRef.current = started.data.bus.id;
        if (started.data.trip?.id) setOperationalTripId(started.data.trip.id);
        return started.data.bus.id;
      }
    } catch (_) {}

    // 4. Fallback to any active bus
    try {
      const { data: fallbackBus } = await supabase.from('buses')
        .select('id').eq('status', 'active').limit(1).maybeSingle();
      if (fallbackBus?.id) {
        busIdRef.current = fallbackBus.id;
        return fallbackBus.id;
      }
    } catch (_) {}

    return null;
  };

  // Helper to broadcast moving vehicle GPS to Supabase & local channels so passenger app updates in real-time
  const broadcastBusGps = async (latitude, longitude, speed, heading, accuracy) => {
    let bId = busIdRef.current;
    if (!bId) {
      bId = await resolveBusId();
    }
    if (!bId) {
      bId = '00000000-0000-0000-0000-000000000402';
      busIdRef.current = bId;
    }

    const payload = {
      bus_id: bId,
      plate_number: dutySession.plateNumber || 'QC-BUS-0402',
      latitude: Number(latitude),
      longitude: Number(longitude),
      speed: speed == null ? null : Number(speed),
      heading: heading == null ? null : Number(heading),
      accuracy: accuracy == null ? null : Number(accuracy),
      updated_at: new Date().toISOString()
    };

    // Instant local/cross-tab sync via BroadcastChannel & localStorage
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('qcbus_live_bus_coords', JSON.stringify(payload));
        if (window.BroadcastChannel) {
          const bc = new BroadcastChannel('qcbus_live_channel');
          bc.postMessage({ type: 'BUS_LOCATION_UPDATE', payload });
          bc.close();
        }
      } catch (_) {}
    }

    return publishCurrentBusLocation(bId, payload);
  };

  const triggerArrivalAtStop = (stopIdx, currentDistance = null) => {
    if (stopIdx < 0 || stopIdx >= stopsList.length) return;
    const targetStop = stopsList[stopIdx];
    const isTargetDestination = (stopIdx === stopsList.length - 1);

    setCurrentStopIndex(stopIdx);
    if (stopIdx < stopsList.length - 1) {
      setHeadingStopIndex(stopIdx + 1);
      setTripPhase('at_stop');
    } else {
      setHeadingStopIndex(stopIdx);
      setTripPhase('completed');
    }

    lastTriggeredStopRef.current = targetStop.id || stopIdx;

    if (!isTripActive) {
      setIsTripActive(true);
    }

    setShowManualRegistration(true);
    setManualDestination(stopsList[stopIdx + 1]?.name || '');

    // AUTO-COMPLETION: When destination stop is reached, auto-complete matching passenger journeys
    const nowIso = new Date().toISOString();
    let autoCompletedCount = 0;
    const completedJourneys = [];

    setPassengerRegistry((prevRows) => {
      let hasChanges = false;
      const nextRows = prevRows.map((row) => {
        if (row.status !== 'boarded') return row;
        const reachedDestination = isSameStop(row.destination_name, targetStop.name);
        if ((reachedDestination || isTargetDestination) && isJourneyMatchingDirection(row, direction)) {
          hasChanges = true;
          const pax = Math.max(1, Number(row.count || row.passenger_count) || 1);
          autoCompletedCount += pax;
          completedJourneys.push(row);
          return {
            ...row,
            status: 'completed',
            alighted_at: nowIso,
            updated_at: nowIso
          };
        }
        return row;
      });

      if (hasChanges) {
        try {
          saveAndSyncRegistry(nextRows);

          // Sync destination arrival so passenger app marks journey completed
          completedJourneys.forEach((j) => {
            const token = j.qr_token || j.id;
            if (token) {
              localStorage.setItem(`qcbus_scanned_${token}`, JSON.stringify({ status: 'completed', alighted_at: nowIso, destination: targetStop.name }));
              document.cookie = `qcbus_scan_${token}=${encodeURIComponent(JSON.stringify({ status: 'completed', stop: targetStop.name, time: Date.now() }))}; path=/; max-age=86400`;
            }
            if (j.id && j.id !== token) {
              localStorage.setItem(`qcbus_scanned_${j.id}`, JSON.stringify({ status: 'completed', alighted_at: nowIso, destination: targetStop.name }));
            }
          });

          // Broadcast to passenger apps
          if (typeof window !== 'undefined' && window.BroadcastChannel) {
            const bc = new BroadcastChannel('qcbus_live_channel');
            bc.postMessage({
              type: 'PASSENGERS_ALIGHTED_AT_STOP',
              payload: {
                stopName: targetStop.name,
                stopIndex: stopIdx,
                completedJourneys: completedJourneys.map(j => ({ id: j.id, qr_token: j.qr_token, count: j.count }))
              }
            });
            bc.close();
          }
        } catch (_) {}
      }
      return nextRows;
    });

    // Background update to Supabase for all auto-completed journeys & boarding events
    if (completedJourneys.length > 0) {
      completedJourneys.forEach(async (j) => {
        const token = j.qr_token || j.id;
        try {
          if (j.id) {
            supabase.from('passenger_journeys').update({
              status: 'completed',
              alighted_at: nowIso,
              updated_at: nowIso
            }).eq('id', j.id).then(({ error: updErr }) => {
              if (updErr && token) {
                supabase.from('passenger_journeys').update({
                  status: 'completed',
                  alighted_at: nowIso,
                  updated_at: nowIso
                }).eq('qr_token', token).catch(() => {});
              }
            }).catch(() => {});
          } else if (token) {
            supabase.from('passenger_journeys').update({
              status: 'completed',
              alighted_at: nowIso,
              updated_at: nowIso
            }).eq('qr_token', token).catch(() => {});
          }
          await recordBoardingEvent({
            tripId: operationalTripId || dutySession?.tripId || null,
            eventType: 'alight',
            method: 'gps_arrival',
            passengerId: j.passenger_id || null,
            journeyId: j.id,
            busId: dutySession?.busId || null,
            idempotencyKey: `auto-alight-${j.id || token}-${stopIdx}-${Date.now()}`
          });
        } catch (_) {}
      });
    }

    const distInfo = (currentDistance != null && Number.isFinite(currentDistance))
      ? ` (${Math.round(currentDistance)}m GPS proximity)`
      : '';

    const autoAlightNotice = autoCompletedCount > 0
      ? ` ${autoCompletedCount} passenger${autoCompletedCount === 1 ? '' : 's'} reached destination! Journey completed & seats restored.`
      : '';

    setStatusMessage(isTargetDestination
      ? `TARGET DESTINATION REACHED: Stop ${stopIdx + 1} (${targetStop.name})${distInfo}! Final terminus reached.${autoAlightNotice} Passenger alighting opened.`
      : `Bus arrived at Stop ${stopIdx + 1} (${targetStop.name})${distInfo}.${autoAlightNotice} Passenger registration opened.`);

    // Immediately reflect vehicle location at arrived stop to Supabase so passenger app live map & destination detector trigger
    if (Number.isFinite(Number(targetStop.lat)) && Number.isFinite(Number(targetStop.lng))) {
      broadcastBusGps(Number(targetStop.lat), Number(targetStop.lng), 0, null, 2);
    }
  };

  // Process incoming GPS fix received from G-703 USB receiver connected to Pi 4B (or bridge)
  const processGpsFix = (fix) => {
    if (!fix || !fix.fix || fix.lost) return;
    const pLat = fix.latitude;
    const pLng = fix.longitude;
    const speedKmh = fix.speed != null ? fix.speed : null;

    setDeviceGps({
      active: true,
      latitude: pLat,
      longitude: pLng,
      accuracy: fix.accuracy || 5,
      speed: speedKmh,
      heading: fix.heading || null,
      satellites: fix.satellites || null,
      altitude: fix.altitude || null,
      error: null,
      lastUpdated: new Date(),
      source: fix.source || 'g703_receiver',
      port: fix.port || null
    });

    // Broadcast position to Supabase & passenger app
    broadcastBusGps(pLat, pLng, speedKmh, fix.heading || null, fix.accuracy || 5);

    // Calculate distances to all stops and evaluate stop progression
    if (stopsList.length > 0) {
      const distMap = {};
      for (let i = 0; i < stopsList.length; i += 1) {
        const stop = stopsList[i];
        const d = calculateDistanceMeters(pLat, pLng, Number(stop.lat), Number(stop.lng));
        distMap[stop.id || `stop-${i + 1}`] = Math.round(d);
        distMap[i] = Math.round(d);
      }
      setStopDistances(distMap);

      // Target heading stop (defaults to stop after current)
      const targetIdx = (headingStopIndex >= 0 && headingStopIndex < stopsList.length)
        ? headingStopIndex
        : Math.min(stopsList.length - 1, currentStopIndex + 1);

      const headingStop = stopsList[targetIdx];
      const distToTarget = headingStop ? calculateDistanceMeters(pLat, pLng, Number(headingStop.lat), Number(headingStop.lng)) : Infinity;
      setDistanceToHeading(Number.isFinite(distToTarget) ? Math.round(distToTarget) : null);

      if (isTripActive) {
        const currentStop = stopsList[currentStopIndex];
        const distToCurrent = currentStop ? calculateDistanceMeters(pLat, pLng, Number(currentStop.lat), Number(currentStop.lng)) : Infinity;

        // 1. ARRIVAL DETECTION: Check if vehicle is within ARRIVAL_RADIUS_METERS of target heading stop
        if (distToTarget <= ARRIVAL_RADIUS_METERS) {
          const arrivalKey = headingStop?.id || targetIdx;
          if (lastTriggeredStopRef.current !== arrivalKey) {
            lastTriggeredStopRef.current = arrivalKey;
            triggerArrivalAtStop(targetIdx, distToTarget);
            return;
          }
        }

        // Catch-up check: Did the vehicle reach an upcoming stop further ahead?
        let catchupIndex = -1;
        for (let k = targetIdx + 1; k < stopsList.length; k += 1) {
          const upcoming = stopsList[k];
          const distUp = calculateDistanceMeters(pLat, pLng, Number(upcoming.lat), Number(upcoming.lng));
          if (distUp <= ARRIVAL_RADIUS_METERS) {
            catchupIndex = k;
            break;
          }
        }
        if (catchupIndex > targetIdx) {
          const catchupStop = stopsList[catchupIndex];
          const catchupKey = catchupStop?.id || catchupIndex;
          if (lastTriggeredStopRef.current !== catchupKey) {
            lastTriggeredStopRef.current = catchupKey;
            triggerArrivalAtStop(catchupIndex, calculateDistanceMeters(pLat, pLng, Number(catchupStop.lat), Number(catchupStop.lng)));
            return;
          }
        }

        // 2. APPROACHING DETECTION
        if (distToTarget <= APPROACH_RADIUS_METERS && tripPhase !== 'at_stop' && tripPhase !== 'approaching') {
          setTripPhase('approaching');
          setStatusMessage(`Approaching Stop ${targetIdx + 1}: ${headingStop?.name} (${Math.round(distToTarget)}m away)`);
        }

        // 3. DEPARTURE DETECTION
        if (tripPhase === 'at_stop' && distToCurrent > DEPARTURE_RADIUS_METERS) {
          setTripPhase('in_transit');
        }
      }
    }
  };

  const requestImmediateGpsFix = async () => {
    try {
      const fix = await fetchLatestBridgeGps();
      if (fix && fix.fix && !fix.lost && typeof fix.latitude === 'number' && typeof fix.longitude === 'number') {
        processGpsFix(fix);
        const src = fix.source === 'g703_serial' ? 'G-703 USB' : (fix.source || 'G-703');
        const sats = fix.satellites ? ` · ${fix.satellites} satellites` : '';
        setStatusMessage(`${src} GPS fix: ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}${sats}`);
      } else {
        setStatusMessage('G-703 GPS: Waiting for satellite fix or GPS lost (>5s).');
      }
    } catch (err) {
      setStatusMessage(`G-703 GPS query error: ${err.message}`);
    }
  };

  // Helper to simulate GPS arrival at the heading stop for desk testing
  const simulateNextStopArrival = () => {
    const nextIdx = (headingStopIndex >= 0 && headingStopIndex < stopsList.length)
      ? headingStopIndex
      : Math.min(stopsList.length - 1, currentStopIndex + 1);
    const stop = stopsList[nextIdx];
    if (stop && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng))) {
      processGpsFix({
        fix: true,
        lost: false,
        latitude: Number(stop.lat),
        longitude: Number(stop.lng),
        speed: 0,
        heading: 45,
        satellites: 9,
        source: 'gps_simulation'
      });
    }
  };

  useEffect(() => {
    resolveBusId();
  }, [dutySession?.plateNumber]);

  // Hardware Bridge GPS Stream Poller from Pi 4B bridge (G-703 USB receiver on Pi 4B)
  useEffect(() => {
    let cancelled = false;

    const bridgeGpsTimer = setInterval(async () => {
      if (cancelled) return;
      const fix = await fetchLatestBridgeGps();
      if (cancelled) return;

      if (fix && fix.fix && !fix.lost && typeof fix.latitude === 'number' && typeof fix.longitude === 'number') {
        processGpsFix(fix);
      } else {
        // Treat data older than 5 seconds or missing fix as "GPS lost"
        setDeviceGps((prev) => {
          if (!prev.active && prev.error === 'GPS lost') return prev;
          return {
            ...prev,
            active: false,
            error: fix?.lost ? 'GPS lost' : (fix?.error || 'GPS lost'),
            lastUpdated: new Date()
          };
        });
      }
    }, 1000); // 1 Hz matching G-703 GPS stream

    return () => {
      cancelled = true;
      clearInterval(bridgeGpsTimer);
    };
  }, [isTripActive, stopsList, headingStopIndex, currentStopIndex, tripPhase, dutySession?.plateNumber]);

  // Keep a stable ref so keyboard event listener doesn't re-create repeatedly
  const handleQrScanRef = useRef(null);

  // Helper to ensure virtual/soft keyboard is dismissed and stays closed
  const dismissSoftKeyboard = () => {
    if (typeof document !== 'undefined') {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      if (window.getSelection) {
        window.getSelection()?.removeAllRanges();
      }
    }
  };

  const playScanBeep = (type = 'success') => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(type === 'success' ? 987.77 : 440, ctx.currentTime);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } catch (_) {}
  };

  // QR Code Processing from the embedded USB/RS232-TTL scanner or Camera Modal
  const handleQrScan = (rawCode) => {
    const raw = String(rawCode || '').trim();
    if (!raw) return;

    dismissSoftKeyboard();
    setTimeout(dismissSoftKeyboard, 50);

    // If trip is not started yet, automatically start the trip so scanning works seamlessly at Stop 1
    if (!isTripActive) {
      setIsTripActive(true);
    }

    // 1. Universal QR Parsing
    const parsed = parsePassengerQRCode(raw);
    const token = parsed?.tripId || raw.match(/(?:Code|Journey ID|Pass ID):\s*([^\r\n]+)/i)?.[1]?.trim() || (raw.length <= 40 ? raw : generateDailyTripId());

    // 2. Look for existing journey in current passengerRegistry
    const savedTestJourney = passengerRegistry.find(
      (row) => (row.qr_token && row.qr_token === token) ||
               (parsed?.tripId && row.qr_token === parsed.tripId) ||
               row.id === token
    );

    // 3. Resolve boarding & destination stops against canonical Route 4 stops
    const rawOrigin = parsed?.boardingStop || savedTestJourney?.origin_name || currentStop?.name || stopsList[0]?.name;
    const rawDest = parsed?.destinationStop || savedTestJourney?.destination_name || stopsList[stopsList.length - 1]?.name;

    let resolvedOrigin = resolveRoute4Stop(rawOrigin, direction) || resolveRoute4Stop(currentStop, direction) || stopsList[0];
    let resolvedDestination = resolveRoute4Stop(rawDest, direction) || stopsList[stopsList.length - 1];

    // If origin and destination ended up identical, default destination to terminus
    if (resolvedOrigin.name === resolvedDestination.name) {
      resolvedDestination = (resolvedOrigin.name === stopsList[stopsList.length - 1].name)
        ? stopsList[0]
        : stopsList[stopsList.length - 1];
    }

    // 4. Direction validation & graceful adaptation (never reject a commuter standing on the bus)
    const passengerDir = parsed?.direction || savedTestJourney?.route_direction || savedTestJourney?.direction || direction;
    const dirValidation = validateTripDirection(passengerDir, resolvedOrigin, resolvedDestination, direction);
    if (!dirValidation.valid) {
      console.warn('Trip direction adapted to current bus direction:', dirValidation.error);
      resolvedOrigin = resolveRoute4Stop(currentStop, direction) || stopsList[currentStopIndex] || stopsList[0];
      const currentIdx = getStopIndex(resolvedOrigin, direction);
      const remainingStops = stopsList.slice(Math.max(0, currentIdx + 1));
      resolvedDestination = remainingStops.length > 0 ? remainingStops[remainingStops.length - 1] : stopsList[stopsList.length - 1];
    }

    // 5. Determine whether boarding or alighting
    // If the passenger is already 'boarded', scanning again means they are alighting!
    const isCurrentlyBoarded = Boolean(savedTestJourney && savedTestJourney.status === 'boarded');
    const nextEventType = isCurrentlyBoarded ? 'alight' : 'board';

    const cat = savedTestJourney?.passenger_category || parsed?.category || savedTestJourney?.profiles?.passenger_category || 'Regular';
    const isPri = isPriorityCategory(cat);
    const count = Math.max(1, Number(savedTestJourney?.count || parsed?.count || savedTestJourney?.passenger_count) || 1);

    // Compute party priority breakdown
    let paxPriCount = isPri ? 1 : 0;
    let paxRegCount = isPri ? 0 : 1;
    if (Array.isArray(parsed?.companionsList) && parsed.companionsList.length > 0) {
      paxPriCount = isPri ? 1 : 0;
      paxRegCount = isPri ? 0 : 1;
      parsed.companionsList.forEach(comp => {
        if (isPriorityCategory(comp.category)) paxPriCount += 1;
        else paxRegCount += 1;
      });
    } else {
      paxPriCount = isPri ? count : 0;
      paxRegCount = !isPri ? count : 0;
    }

    const now = new Date().toISOString();

    // 6. Capacity check if boarding (check overall bus capacity)
    if (nextEventType === 'board') {
      if (totalOnboard + count > busCapacity) {
        playScanBeep('error');
        setStatusMessage(`Boarding rejected: Bus at full capacity (${totalOnboard}/${busCapacity}). Cannot board ${count} passenger(s).`);
        dismissSoftKeyboard();
        return;
      }
    }

    playScanBeep('success');

    const effectiveTripId = operationalTripId || dutySession?.tripId || 'operational-trip';

    // 7. Construct Updated Journey Record
    const updatedJourney = {
      ...(savedTestJourney || {}),
      id: savedTestJourney?.id || token,
      trip_id: effectiveTripId,
      qr_token: savedTestJourney?.qr_token || token,
      count,
      passenger_count: count,
      passenger_category: cat,
      passenger_name: savedTestJourney?.passenger_name || parsed?.passengerName || (isPri ? 'Priority Commuter' : 'Regular Commuter'),
      is_priority: isPri,
      priority_count: paxPriCount,
      regular_count: paxRegCount,
      origin_name: resolvedOrigin.name,
      destination_name: resolvedDestination.name,
      direction,
      route_direction: direction,
      status: nextEventType === 'board' ? 'boarded' : 'completed',
      boarded_at: nextEventType === 'board' ? (savedTestJourney?.boarded_at || now) : savedTestJourney?.boarded_at,
      alighted_at: nextEventType === 'alight' ? now : savedTestJourney?.alighted_at,
      updated_at: now
    };

    // 8. Update Registry State and Storage IMMEDIATELY & SYNCHRONOUSLY
    setPassengerRegistry((rows) => {
      const exists = rows.some((row) => (row.qr_token && row.qr_token === token) || row.id === updatedJourney.id);
      const nextRows = exists
        ? rows.map((row) => ((row.qr_token && row.qr_token === token) || row.id === updatedJourney.id) ? { ...row, ...updatedJourney } : row)
        : [...rows, updatedJourney];

      try {
        const plate = dutySession?.plateNumber || 'QC-BUS';
        saveAndSyncRegistry(nextRows);
        localStorage.setItem(`qcbus_scanned_${token}`, JSON.stringify({
          status: updatedJourney.status,
          scanned_at: now,
          origin: resolvedOrigin.name,
          destination: resolvedDestination.name
        }));
        if (updatedJourney.id && updatedJourney.id !== token) {
          localStorage.setItem(`qcbus_scanned_${updatedJourney.id}`, JSON.stringify({
            status: updatedJourney.status,
            scanned_at: now,
            origin: resolvedOrigin.name,
            destination: resolvedDestination.name
          }));
        }

        // Shared cookie for cross-port localhost sync (passenger-app port 5173 <-> personnel-app port 5174)
        const cookiePayload = encodeURIComponent(JSON.stringify({
          status: updatedJourney.status,
          stop: nextEventType === 'board' ? resolvedOrigin.name : resolvedDestination.name,
          time: Date.now()
        }));
        document.cookie = `qcbus_scan_${token}=${cookiePayload}; path=/; max-age=86400`;
        if (updatedJourney.id && updatedJourney.id !== token) {
          document.cookie = `qcbus_scan_${updatedJourney.id}=${cookiePayload}; path=/; max-age=86400`;
        }

        const newOnboard = nextEventType === 'board' ? totalOnboard + count : Math.max(0, totalOnboard - count);
        const liveOcc = {
          bus_plate: plate,
          trip_id: effectiveTripId,
          direction,
          current_onboard: newOnboard,
          bus_capacity: busCapacity,
          available_seats: Math.max(0, busCapacity - newOnboard),
          priority_boarded: nextEventType === 'board' ? priorityBoarded + paxPriCount : Math.max(0, priorityBoarded - paxPriCount),
          regular_boarded: nextEventType === 'board' ? regularBoarded + paxRegCount : Math.max(0, regularBoarded - paxRegCount),
          available_priority_seats: Math.max(0, prioritySeatCapacity - (nextEventType === 'board' ? priorityBoarded + paxPriCount : Math.max(0, priorityBoarded - paxPriCount))),
          available_regular_seats: Math.max(0, regularSeatCapacity - (nextEventType === 'board' ? regularBoarded + paxRegCount : Math.max(0, regularBoarded - paxRegCount))),
          last_scanned_token: token,
          last_scanned_status: updatedJourney.status,
          updated_at: now
        };
        localStorage.setItem('qcbus_live_occupancy', JSON.stringify(liveOcc));

        if (window.BroadcastChannel) {
          const bc = new BroadcastChannel('qcbus_live_channel');
          bc.postMessage({
            type: nextEventType === 'board' ? 'PASSENGER_BOARDED' : 'PASSENGER_ALIGHTED',
            payload: {
              token,
              journeyId: updatedJourney.id,
              origin: resolvedOrigin.name,
              destination: resolvedDestination.name,
              status: updatedJourney.status,
              count
            }
          });
          bc.close();
        }
      } catch (_) {}
      return nextRows;
    });

    // 9. Feedback Status Message
    if (nextEventType === 'board') {
      const remainingPriority = Math.max(0, availablePrioritySeats - paxPriCount);
      const remainingRegular = Math.max(0, availableRegularSeats - paxRegCount);
      const newTotal = totalOnboard + count;
      setStatusMessage(
        `${count} PASSENGER${count === 1 ? '' : 'S'} BOARDED (${cat}). Total Onboard: ${newTotal}/${busCapacity}. Remaining: ${remainingPriority} Priority / ${remainingRegular} Regular. Boarding at: ${resolvedOrigin.name} -> Destination: ${resolvedDestination.name}.`
      );
    } else {
      const newTotal = Math.max(0, totalOnboard - count);
      setStatusMessage(
        `${count} PASSENGER${count === 1 ? '' : 'S'} ALIGHTED at ${resolvedDestination.name}. ${count} seat${count === 1 ? '' : 's'} restored. Total Onboard: ${newTotal}/${busCapacity}.`
      );
    }

    // 10. Non-blocking Background Sync to Supabase
    (async () => {
      let activeTripId = operationalTripId || dutySession?.tripId || null;
      if (!activeTripId) {
        try {
          activeTripId = await ensureOperationalTrip();
        } catch (_) {
          activeTripId = dutySession?.tripId || null;
        }
      }

      const updateData = {
        status: updatedJourney.status,
        trip_id: activeTripId,
        origin_name: resolvedOrigin.canonicalDbName || resolvedOrigin.name,
        destination_name: resolvedDestination.canonicalDbName || resolvedDestination.name,
        boarded_at: updatedJourney.boarded_at,
        alighted_at: updatedJourney.alighted_at,
        updated_at: now
      };

      const isUuid = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));

      try {
        if (updatedJourney.id && isUuid(updatedJourney.id)) {
          const { error: updErr } = await supabase.from('passenger_journeys').update(updateData).eq('id', updatedJourney.id);
          if (updErr && token) {
            await supabase.from('passenger_journeys').update(updateData).eq('qr_token', token);
          }
        } else if (token) {
          const { data: updateRes, error: updErr } = await supabase.from('passenger_journeys').update(updateData).eq('qr_token', token).select();
          if (!updErr && (!updateRes || updateRes.length === 0)) {
            // Not found in DB, insert so DB has it
            await supabase.from('passenger_journeys').insert([{
              id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined,
              qr_token: token,
              passenger_name: updatedJourney.passenger_name,
              passenger_category: cat,
              passenger_count: count,
              origin_name: resolvedOrigin.canonicalDbName || resolvedOrigin.name,
              destination_name: resolvedDestination.canonicalDbName || resolvedDestination.name,
              route_direction: direction,
              status: updatedJourney.status,
              boarded_at: updatedJourney.boarded_at,
              alighted_at: updatedJourney.alighted_at,
              registration_source: 'qr_scan',
              trip_id: activeTripId
            }]);
          }
        }
      } catch (syncErr) {
        console.warn('Background Supabase update notice:', syncErr.message);
      }

      recordBoardingEvent({
        tripId: activeTripId,
        eventType: nextEventType,
        method: 'qr',
        passengerId: updatedJourney.passenger_id || null,
        journeyId: updatedJourney.id,
        busId: dutySession?.busId || null,
        idempotencyKey: `qr-${updatedJourney.id || token}-${nextEventType}-${Date.now()}`
      }).catch(() => {});
    })();

    dismissSoftKeyboard();
    setTimeout(dismissSoftKeyboard, 50);
  };

  useEffect(() => {
    handleQrScanRef.current = handleQrScan;
  });

  // Capture keyboard-wedge USB scanners & RS232-TTL scanners
  useEffect(() => {
    const onScannerKeyDown = (event) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      );
      if (isEditable || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Enter' || event.key === 'Tab') {
        const scannedValue = scannerBufferRef.current.trim();
        scannerBufferRef.current = '';
        window.clearTimeout(scannerResetTimerRef.current);
        if (scannedValue) {
          event.preventDefault();
          dismissSoftKeyboard();
          setTimeout(dismissSoftKeyboard, 50);
          if (handleQrScanRef.current) {
            handleQrScanRef.current(scannedValue);
          }
        }
        return;
      }

      if (event.key.length === 1) {
        scannerBufferRef.current += event.key;
        window.clearTimeout(scannerResetTimerRef.current);

        // Auto-detect complete JSON payload if sent by USB scanner without trailing Enter
        const buf = scannerBufferRef.current.trim();
        if (buf.startsWith('{') && buf.endsWith('}')) {
          try {
            JSON.parse(buf);
            scannerBufferRef.current = '';
            if (handleQrScanRef.current) {
              handleQrScanRef.current(buf);
            }
            return;
          } catch (_) {}
        }

        scannerResetTimerRef.current = window.setTimeout(() => {
          scannerBufferRef.current = '';
        }, 1500); // 1.5s tolerance for slow USB hardware wedge scanners
      }
    };

    window.addEventListener('keydown', onScannerKeyDown);
    return () => {
      window.removeEventListener('keydown', onScannerKeyDown);
      window.clearTimeout(scannerResetTimerRef.current);
    };
  }, []);

  // Start Trip Handler (Rule 1: POST /api/trip/start {"direction": "Northbound" | "Southbound"})
  // Rule 4: Send trip commands only after confirming the 3B is online.
  const handleStartTrip = async (forceNewTrip = false) => {
    // If Pi 3B is offline, log notice but allow local G-703 GPS-guided trip
    if (!announcerInfo.online && !isTestMode) {
      console.info('Pi 3B Announcer offline; proceeding with local G-703 GPS-guided trip on Pi 4B.');
    }

    setStatusMessage(forceNewTrip ? 'Starting a new trip…' : `Starting trip (${direction})…`);
    let activeTripId;
    try {
      activeTripId = await ensureOperationalTrip();
      if (forceNewTrip) {
        const nextTrip = await startNextTrip({ currentTripId: activeTripId, direction });
        if (!nextTrip.success || !nextTrip.data?.id) throw new Error(nextTrip.error || 'Unable to start the next trip.');
        activeTripId = nextTrip.data.id;
        setOperationalTripId(activeTripId);
        updateDutySession({ tripId: activeTripId, tripDirection: direction });
      }
    } catch (error) {
      console.warn('Trip setup warning:', error.message);
    }

    localStorage.removeItem(tripSegmentKey);
    setTripSegmentStartedAt(0);
    setPassengerRegistry([]);
    lastTriggeredStopRef.current = stopsList[0]?.id || 0;
    lastTripsDoneRef.current = announcerInfo.state?.trips_done ?? 0;
    setCurrentStopIndex(0);
    setHeadingStopIndex(1);
    setTripPhase('waiting');
    setDistanceToHeading(null);
    setIsTripActive(true);
    if (forceNewTrip) setTripCount((prev) => prev + 1);

    // Always attempt the bridge request. The status poll can be briefly stale,
    // and the bridge itself returns the authoritative Pi 3B result.
    const bridgeRes = await sendTripStart(direction, { force: forceNewTrip });
    const displayedTrip = forceNewTrip ? tripCount + 1 : tripCount;

    if (bridgeRes.ok || bridgeRes.success) {
      setStatusMessage(`Trip #${displayedTrip} (${direction}) started at ${stopsList[0]?.name || 'Origin'}. G-703 GPS & Announcer active.`);
    } else if (bridgeRes.conflict || bridgeRes.status === 409) {
      setIsTripActive(true);
      setStatusMessage(`Trip is already active on Pi 3B (${direction}) — continuing active trip.`);
    } else {
      setStatusMessage(`Trip started locally. Pi 3B command failed: ${bridgeRes.error || 'Bridge unavailable'}`);
    }

    setTimeout(() => setStatusMessage(null), 6000);
  };

  // End Trip Handler
  const handleEndTrip = async () => {
    setStatusMessage('Ending trip...');
    setIsTripActive(false);
    setTripPhase('idle');
    setDistanceToHeading(null);

    // Send even if the latest status poll says offline; it may be stale.
    const bridgeRes = await sendTripEnd();
    if (bridgeRes.ok || bridgeRes.success) {
      setStatusMessage('Trip ended. Announcer set to standby.');
    } else {
      setStatusMessage(`Trip ended locally. Pi 3B command failed: ${bridgeRes.error || 'Bridge unavailable'}`);
    }

    // Prompt to alight any remaining onboard passengers
    const remainingOnboard = passengerRegistry.filter((j) => j.status === 'boarded').length;
    if (remainingOnboard > 0) {
      setShowManualRegistration(true);
    }
  };

  // Alias for starting next trip
  const handleStartAnotherTrip = () => handleStartTrip(true);
  const handlePauseTrip = handleEndTrip;

  const handleAlightCurrentStopPassengers = async () => {
    const targetCanonical = resolveRoute4Stop(currentStop.name)?.name || currentStop.name;
    const now = new Date().toISOString();

    const alightingJourneys = passengerRegistry.filter((journey) => {
      const isCurrentlyBoarded = journey.status === 'boarded';
      const stopCanonical = resolveRoute4Stop(journey.destination_name)?.name || journey.destination_name;
      return isCurrentlyBoarded && isJourneyMatchingDirection(journey, direction) && stopCanonical === targetCanonical;
    });

    if (alightingJourneys.length === 0) return;

    const totalAlightingPax = alightingJourneys.reduce((sum, j) => sum + (Number(j.count) || 1), 0);

    // Update local state immediately
    setPassengerRegistry((prev) => {
      const alightingIds = new Set(alightingJourneys.map((j) => j.id || j.qr_token));
      const next = prev.map((j) => {
        if (alightingIds.has(j.id) || (j.qr_token && alightingIds.has(j.qr_token))) {
          return { ...j, status: 'completed', alighted_at: now };
        }
        return j;
      });
      saveAndSyncRegistry(next);
      return next;
    });

    setStatusMessage(`${totalAlightingPax} passenger${totalAlightingPax === 1 ? '' : 's'} alighted at ${targetCanonical}. Freed seats and updated onboard count.`);

    // Sync in background
    let activeTripId = operationalTripId || dutySession?.tripId;
    for (const journey of alightingJourneys) {
      if (journey.id && !String(journey.id).startsWith('manual-')) {
        supabase.from('passenger_journeys')
          .update({ status: 'completed', alighted_at: now })
          .eq('id', journey.id)
          .catch(() => {});
        if (activeTripId) {
          recordBoardingEvent({
            tripId: activeTripId,
            eventType: 'alight',
            method: 'dashboard',
            journeyId: journey.id,
            idempotencyKey: `alight-${journey.id}-${Date.now()}`
          }).catch(() => {});
        }
      }
    }
  };

  const handleAlightAllRemainingPassengers = async () => {
    const now = new Date().toISOString();
    const onboardJourneys = passengerRegistry.filter((j) => j.status === 'boarded' && isJourneyMatchingDirection(j, direction));
    if (onboardJourneys.length === 0) return;

    const totalPax = onboardJourneys.reduce((sum, j) => sum + (Number(j.count) || 1), 0);

    setPassengerRegistry((prev) => {
      const next = prev.map((j) => (j.status === 'boarded' && isJourneyMatchingDirection(j, direction)) ? { ...j, status: 'completed', alighted_at: now } : j);
      saveAndSyncRegistry(next);
      return next;
    });

    setStatusMessage(`All ${totalPax} remaining passengers alighted at ${currentStop.name}. Trip complete.`);
  };

  const handleManualRegistration = async (event) => {
    event.preventDefault();
    if (!manualDestination || manualSubmissionRef.current) return;
    if (!isTripActive) {
      setStatusType('error');
      setStatusMessage('Registration Failed');
      return;
    }
    manualSubmissionRef.current = true;
    setManualRegistrationBusy(true);

    const count = Math.max(1, Number(manualPassengerCount) || 1);
    const capacity = busCapacity;
    if (totalOnboard + count > capacity) {
      setStatusType('error');
      setStatusMessage('Registration Failed');
      setManualRegistrationBusy(false);
      manualSubmissionRef.current = false;
      return;
    }
    const isPri = isPriorityCategory(manualPassengerCategory);

    let activeTripId = operationalTripId || dutySession?.tripId || null;
    if (!activeTripId) {
      try {
        activeTripId = await ensureOperationalTrip();
      } catch (error) {
        console.warn('Operational trip creation notice:', error.message);
      }
    }

    const canonicalOrigin = resolveRoute4Stop(currentStop.name)?.name || currentStop.name;
    const canonicalDest = resolveRoute4Stop(manualDestination)?.name || manualDestination;
    const now = new Date().toISOString();
    const anonPassId = 'ANON-' + Math.floor(100000 + Math.random() * 900000);
    const anonPassengerName = 'Anonymous Passenger';

    // Attempt DB creation
    let createdJourney = null;
    try {
      const created = await createManualPassengerJourney({
        passengerName: anonPassengerName,
        passengerCategory: manualPassengerCategory,
        origin: canonicalOrigin,
        destination: canonicalDest,
        tripId: activeTripId,
        routeDirection: direction,
        passengerCount: count,
        status: 'boarded',
        passId: anonPassId
      });
      if (created.success && created.data) {
        createdJourney = created.data;
      }
    } catch (err) {
      console.warn('Database manual journey notice:', err.message);
    }

    const localJourney = {
      id: createdJourney?.id || anonPassId,
      pass_id: anonPassId,
      qr_token: createdJourney?.qr_token || anonPassId,
      trip_id: activeTripId,
      direction: direction,
      route_direction: direction,
      passenger_name: anonPassengerName,
      passenger_category: manualPassengerCategory,
      is_priority: isPri,
      origin_name: canonicalOrigin,
      destination_name: canonicalDest,
      count,
      status: 'boarded',
      boarded_at: now,
      registration_source: 'manual_stop_arrival'
    };

    // Immediately update local passengerRegistry and broadcast sync
    setPassengerRegistry((prev) => {
      const next = [...prev, localJourney];
      saveAndSyncRegistry(next);
      return next;
    });

    // Record boarding event in background if online
    if (activeTripId && createdJourney?.id) {
      recordBoardingEvent({
        tripId: activeTripId,
        eventType: 'board',
        method: 'dashboard',
        journeyId: createdJourney.id,
        idempotencyKey: `manual-${createdJourney.id}`
      }).catch((e) => console.warn('Record boarding event notice:', e.message));
    }

    setStatusType('success');
    setStatusMessage('Registration Success');
    setShowManualRegistration(false);
    setManualRegistrationBusy(false);
    manualSubmissionRef.current = false;
  };

  // Rule 1: "Selecting a direction in the UI should only store it. Send the request when Start Trip is pressed."
  const handleDirectionToggle = (newDir) => {
    if (newDir !== 'Northbound' && newDir !== 'Southbound') return;
    lastTriggeredStopRef.current = null;
    setDirection(newDir);
    setCurrentStopIndex(0);
    setHeadingStopIndex(1);
    updateDutySession({ tripDirection: newDir });
    setStatusMessage(`Direction selected: ${newDir}. Click "Start Trip" to start announcer.`);
  };

  // Format Time: Hours and Minutes ONLY (e.g. "10:30 AM")
  const timeFormatted = currentTime.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit'
  });

  // Format Date Today (e.g. "Wed, Oct 15, 2026")
  const dateFormatted = currentTime.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'auto', minHeight: 'calc(100vh - 5rem)', gap: '0.6rem', boxSizing: 'border-box' }}>
      {/* TOP CONTAINER (Matching Attached Design 1) */}
      <div
        className="card"
        style={{
          padding: '1rem 1.25rem',
          flexShrink: 0,
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1.25rem'
        }}
      >
        {/* Left: Driver / Conductor / Plate & Direction Buttons + Start Trip */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.95rem' }}>
            <div>
              <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Driver Name: </span>
              <span style={{ color: 'var(--text-main)' }}>{dutySession.driverName || '—'}</span>
            </div>
            <div>
              <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Conductor Name: </span>
              <span style={{ color: 'var(--text-main)' }}>{dutySession.conductorName || '—'}</span>
            </div>
            <div>
              <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Plate Number: </span>
              <span style={{ color: 'var(--text-main)' }}>{dutySession.plateNumber || '—'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => handleDirectionToggle('Northbound')}
              style={{
                padding: '0.35rem 0.85rem',
                fontSize: '0.88rem',
                fontWeight: 700,
                borderRadius: 'var(--radius-sm)',
                border: direction === 'Northbound' ? '1px solid #2563eb' : '1px solid rgba(255, 255, 255, 0.2)',
                backgroundColor: direction === 'Northbound' ? '#2563eb' : 'transparent',
                color: '#ffffff',
                cursor: 'pointer'
              }}
            >
              Northbound ↑
            </button>
            <button
              type="button"
              onClick={() => handleDirectionToggle('Southbound')}
              style={{
                padding: '0.35rem 0.85rem',
                fontSize: '0.88rem',
                fontWeight: 700,
                borderRadius: 'var(--radius-sm)',
                border: direction === 'Southbound' ? '1px solid #2563eb' : '1px solid rgba(255, 255, 255, 0.2)',
                backgroundColor: direction === 'Southbound' ? '#2563eb' : 'transparent',
                color: '#ffffff',
                cursor: 'pointer'
              }}
            >
              Southbound ↓
            </button>
            {!isTripActive ? (
              <button
                type="button"
                onClick={() => handleStartTrip(false)}
                style={{
                  padding: '0.35rem 1rem',
                  fontSize: '0.88rem',
                  fontWeight: 700,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid #10b981',
                  backgroundColor: '#10b981',
                  color: '#ffffff',
                  cursor: 'pointer'
                }}
              >
                ► Start Trip ({direction})
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEndTrip}
                style={{
                  padding: '0.35rem 1rem',
                  fontSize: '0.88rem',
                  fontWeight: 700,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid #ef4444',
                  backgroundColor: '#ef4444',
                  color: '#ffffff',
                  cursor: 'pointer'
                }}
              >
                End Trip
              </button>
            )}
          </div>
        </div>

        {/* Center: Live Digital Clock & Date */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.1rem', fontWeight: 800, color: 'var(--text-main)', letterSpacing: '0.02em', lineHeight: 1.1 }}>
            {timeFormatted}
          </div>
          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#06b6d4', marginTop: '0.25rem' }}>
            {dateFormatted}
          </div>
        </div>

        {/* Right: Onboard Count & Available Seats Breakdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.75rem' }}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-main)', letterSpacing: '0.04em' }}>
              ONBOARD
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', lineHeight: 1 }}>
              <span style={{ fontSize: '3.6rem', fontWeight: 800, color: 'var(--text-main)', fontVariantNumeric: 'tabular-nums' }}>
                {totalOnboard}
              </span>
              <span style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-main)', marginLeft: '0.15rem' }}>
                /{busCapacity}
              </span>
            </div>
          </div>

          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-main)', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
              AVAILABLE SEATS
            </div>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-main)' }}>
              PRIORITY: {availablePrioritySeats}/{prioritySeatCapacity}
            </div>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-main)' }}>
              NON-PRIORITY: {availableRegularSeats}/{regularSeatCapacity}
            </div>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div
          className={`alert ${statusType === 'error' ? 'alert-danger' : 'alert-success'}`}
          style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', margin: 0, flexShrink: 0 }}
        >
          {statusMessage}
        </div>
      )}

      {/* MANUAL PASSENGER REGISTRATION & STOP ARRIVAL MODAL */}
      {showManualRegistration && (
        <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'grid', placeItems: 'center', zIndex: 1500, padding: '1rem' }}>
          <div className="card" style={{ width: 'min(520px, 100%)', padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.65rem' }}>
              <span className={`badge ${currentStopIndex === stopsList.length - 1 ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: '0.75rem', fontWeight: 800 }}>
                {currentStopIndex === stopsList.length - 1 ? 'TARGET DESTINATION REACHED (STOP 15 OF 15)' : `BUS AT STOP ${currentStopIndex + 1} OF 15`}
              </span>
              <button type="button" onClick={() => setShowManualRegistration(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.25rem', padding: '0 0.25rem' }}>×</button>
            </div>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, marginBottom: '0.25rem', color: 'var(--text-main)' }}>
              {currentStopIndex === stopsList.length - 1 ? 'Final Terminal Arrival' : `Stop ${currentStopIndex + 1}: Passenger Registry`}
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: '1.4' }}>
              {currentStopIndex === stopsList.length - 1 ? (
                <span style={{ color: 'var(--color-warning)', fontWeight: 700 }}>Bus has arrived at target destination terminal: <strong>{currentStop.name}</strong></span>
              ) : (
                <span>Bus at Stop {currentStopIndex + 1}: <strong style={{ color: 'var(--color-accent)' }}>{currentStop.name}</strong></span>
              )}
            </p>

            {/* ALIGHTING PASSENGERS AT THIS STOP */}
            {(passengersAlightingAt(currentStop.name) > 0 || (currentStopIndex === stopsList.length - 1 && totalOnboard > 0)) && (
              <div style={{ padding: '.75rem .9rem', marginBottom: '1rem', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(239, 68, 68, .12)', border: '1px solid #ef4444' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' }}>
                  <span style={{ color: '#f87171', fontWeight: 800, fontSize: '.9rem' }}>
                    Alighting at this Stop: {currentStopIndex === stopsList.length - 1 ? totalOnboard : passengersAlightingAt(currentStop.name)} pax
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={currentStopIndex === stopsList.length - 1 ? handleAlightAllRemainingPassengers : handleAlightCurrentStopPassengers}
                  style={{ width: '100%', backgroundColor: '#ef4444', color: '#ffffff', fontWeight: 700, padding: '0.55rem', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer' }}
                >
                  Confirm Alighting ({currentStopIndex === stopsList.length - 1 ? totalOnboard : passengersAlightingAt(currentStop.name)} pax)
                </button>
              </div>
            )}

            {passengersCompletedAlightedAt(currentStop.name) > 0 && (
              <div style={{ padding: '.45rem .75rem', marginBottom: '.75rem', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(148, 163, 184, .1)', border: '1px solid #64748b', color: 'var(--text-muted)', fontSize: '.78rem' }}>
                {passengersCompletedAlightedAt(currentStop.name)} passenger(s) have already alighted at this stop.
              </div>
            )}

            {/* BOARDING SECTION (NOT TERMINAL STOP) */}
            {currentStopIndex < stopsList.length - 1 ? (
              <form onSubmit={handleManualRegistration}>
                <div style={{ padding: '.65rem .8rem', marginBottom: '.75rem', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--bg-subtle)', border: '1px solid var(--border-color)', color: 'var(--text-main)', fontWeight: 800, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Already boarded at this stop:</span>
                  <span style={{ fontSize: '1rem' }}>{passengersBoardedAt(currentStop.name)} pax</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '.6rem', marginTop: '.75rem' }}>
                  <div>
                    <label className="form-label" htmlFor="manual-passenger-category">
                      Passenger Category
                    </label>
                    <select
                      id="manual-passenger-category"
                      className="form-select"
                      value={manualPassengerCategory}
                      onChange={(e) => setManualPassengerCategory(e.target.value)}
                    >
                      <option value="Regular">Regular Passenger (Non-Priority /30)</option>
                      <option value="Student">Student (Non-Priority /30)</option>
                      <option value="Senior Citizen">Senior Citizen (Priority /20)</option>
                      <option value="PWD">PWD - Person with Disability (Priority /20)</option>
                      <option value="Pregnant">Pregnant Passenger (Priority /20)</option>
                    </select>
                  </div>
                  <div>
                    <label className="form-label" htmlFor="manual-passenger-count">
                      Pax Count
                    </label>
                    <input
                      id="manual-passenger-count"
                      type="number"
                      min="1"
                      max="50"
                      className="form-input"
                      value={manualPassengerCount}
                      onChange={(e) => setManualPassengerCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ textAlign: 'center', fontWeight: 700 }}
                    />
                  </div>
                </div>

                <label className="form-label" htmlFor="manual-passenger-destination" style={{ marginTop: '.75rem' }}>
                  Destination Stop
                </label>
                <select
                  id="manual-passenger-destination"
                  className="form-select"
                  value={manualDestination}
                  onChange={(e) => setManualDestination(e.target.value)}
                  required
                >
                  <option value="">Select destination (Stops {currentStopIndex + 2} to 15)</option>
                  {stopsList.slice(currentStopIndex + 1).map((stop, sIdx) => (
                    <option key={stop.id || sIdx} value={stop.name}>
                      Stop {currentStopIndex + 2 + sIdx}: {stop.name}
                    </option>
                  ))}
                </select>

                <div style={{ display: 'flex', gap: '.6rem', marginTop: '1.25rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowManualRegistration(false)}>Close / Skip</button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ flex: 1, fontWeight: 700 }}
                    disabled={manualRegistrationBusy || !isTripActive || !manualDestination}
                  >
                    {manualRegistrationBusy ? 'Registering…' : `Confirm & Board ${manualPassengerCount} Passenger${manualPassengerCount > 1 ? 's' : ''}`}
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ marginTop: '1rem', textAlign: 'center' }}>
                <p style={{ color: 'var(--color-warning)', fontSize: '.9rem' }}>This is the final stop of the route. No new boardings allowed.</p>
                <button type="button" className="btn btn-secondary" onClick={() => setShowManualRegistration(false)} style={{ width: '100%', marginTop: '.5rem' }}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN ROUTE STOP SEQUENCE SECTION */}
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0.75rem', overflow: 'visible', minHeight: '0' }}>
        {/* Sequence Title (Removed Image 2 Elements) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', paddingBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>
            Route Stop Sequence ({direction} View: {direction === 'Northbound' ? 'QC Hall to Gen. Luis' : 'Gen. Luis to QC Hall'})
          </h2>
        </div>

        {/* 15 STOPS DENSE GRID - ONLY CURRENT STOP IN GREEN, ALREADY DONE IN GRAY */}
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
          gap: '0.5rem',
          height: 'auto',
          overflow: 'visible'
        }}>
          {stopsList.map((s, idx) => {
            const isCurrent = idx === currentStopIndex;
            const isPassed = idx < currentStopIndex;
            const stopDist = stopDistances[idx] ?? stopDistances[s.id];
            const boardedCount = passengersBoardedAt(s.name);
            const alightingCount = passengersAlightingAt(s.name);
            const completedAlightedCount = passengersCompletedAlightedAt(s.name);
            const recBoarding = getStopRecommendedBoarding(s.name, direction, currentTime);

            return (
              <div
                key={s.id || idx}
                onClick={() => triggerArrivalAtStop(idx)}
                title={`Click to set Bus at Stop ${idx + 1} and open manual passenger registration`}
                style={{
                  padding: '0.55rem',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  border: isCurrent
                    ? '2px solid #10b981'
                    : (isPassed ? '1px solid #475569' : '1px solid var(--border-color)'),
                  backgroundColor: isCurrent
                    ? 'rgba(16, 185, 129, 0.12)'
                    : (isPassed ? 'rgba(71, 85, 105, 0.15)' : 'var(--bg-card)'),
                  opacity: isPassed ? 0.75 : 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                    <span style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      backgroundColor: isCurrent ? '#10b981' : (isPassed ? '#475569' : 'var(--bg-subtle)'),
                      color: isCurrent ? '#ffffff' : (isPassed ? '#cbd5e1' : 'var(--text-main)'),
                      border: isCurrent ? '1px solid #10b981' : (isPassed ? '1px solid #475569' : '1px solid var(--border-color)'),
                      padding: '0.15rem 0.45rem',
                      borderRadius: 'var(--radius-sm)'
                    }}>
                      {isCurrent ? `STOP ${idx + 1} · CURRENT` : (isPassed ? `STOP ${idx + 1} · DONE` : `STOP ${idx + 1}`)}
                    </span>
                    {stopDist != null && (
                      <span style={{
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        color: isCurrent ? '#10b981' : (isPassed ? '#94a3b8' : 'var(--text-muted)'),
                        padding: '0.12rem 0.38rem'
                      }}>
                        {isCurrent ? 'At Stop' : (isPassed ? 'Passed' : `${stopDist}m`)}
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    color: isCurrent ? '#10b981' : (isPassed ? '#94a3b8' : 'var(--text-main)'),
                    lineHeight: 1.35,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {s.name}
                  </div>
                </div>

                <div>
                  {/* BOARDED & ALIGHTING COUNTERS */}
                  <div style={{ display: 'flex', gap: '.3rem', marginTop: '.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    {boardedCount > 0 && (
                      <span style={{ padding: '.12rem .35rem', borderRadius: 'var(--radius-sm)', background: 'rgba(16,185,129,.15)', border: '1px solid #10b981', color: '#10b981', fontSize: '.68rem', fontWeight: 700 }}>
                        Boarded: {boardedCount}
                      </span>
                    )}
                    {alightingCount > 0 && (
                      <span style={{ padding: '.12rem .35rem', borderRadius: 'var(--radius-sm)', background: 'rgba(239,68,68,.15)', border: '1px solid #ef4444', color: '#ef4444', fontSize: '.68rem', fontWeight: 700 }}>
                        Alighting: {alightingCount}
                      </span>
                    )}
                    {completedAlightedCount > 0 && (
                      <span style={{ padding: '.12rem .35rem', borderRadius: 'var(--radius-sm)', background: 'rgba(148,163,184,.15)', border: '1px solid #64748b', color: '#94a3b8', fontSize: '.68rem', fontWeight: 600 }}>
                        Alighted: {completedAlightedCount}
                      </span>
                    )}
                    {boardedCount === 0 && alightingCount === 0 && completedAlightedCount === 0 && (
                      <span style={{ fontSize: '.65rem', color: 'var(--text-dim)' }}>0 pax</span>
                    )}
                  </div>

                  {/* RECOMMENDED PASSENGERS TO BE BOARDED */}
                  <div
                    style={{
                      marginTop: '0.45rem',
                      paddingTop: '0.35rem',
                      borderTop: '1px solid var(--border-color)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      Rec. Board:
                    </span>
                    <span style={{
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: 'var(--text-main)',
                      padding: '0.1rem 0.35rem'
                    }}>
                      {recBoarding?.isTerminal ? '0 (Terminus)' : `${recBoarding?.currentPeriodRecommended ?? recBoarding?.overallRecommended} pax`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* BOTTOM QUICK CONTROLS - Start Trip button removed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', paddingTop: '0.65rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', flexShrink: 0, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => triggerArrivalAtStop(currentStopIndex)}
            className="btn btn-secondary"
            style={{ padding: '0.45rem 0.85rem', fontSize: '0.85rem' }}
          >
            Register Passengers (Stop {currentStopIndex + 1})
          </button>

          <button
            type="button"
            onClick={() => {
              if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
              setIsCameraOpen(true);
            }}
            className="btn btn-secondary"
            style={{ padding: '0.45rem 0.85rem', fontSize: '0.85rem' }}
          >
            Scan Pass
          </button>

          {isTripActive && (
            <button
              type="button"
              onClick={handleEndTrip}
              className="btn btn-danger"
              style={{
                justifyContent: 'center',
                padding: '0.45rem 1.15rem',
                fontSize: '0.88rem',
                fontWeight: 700
              }}
            >
              End Trip
            </button>
          )}
        </div>
      </div>

      {/* CAMERA SCANNER MODAL */}
      <QrCameraScannerModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onScan={handleQrScan}
        title="Route 4 QR Pass Scanner"
      />
    </div>
  );
}
