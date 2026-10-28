import { h as useDeepCompareEffect, i as useForceUpdate, j as useApiIsLoaded, k as useCallbackRef, _ as __rest, A as APIProviderContext, l as useApiLoadingStatus, m as APILoadingStatus, n as logErrorOnce, o as useEffectEvent, p as useMapsLibrary, u as usePropBinding, a as useDomEventListener, q as deepEqual, r as useMemoized, s as setValueForStyles, G as GestureHandling$1, b as GoogleMaps3DContext$1, M as Map3D$1, c as MapMode$1, d as Marker3D$1, e as Marker3DContext$1, P as Popover$1, f as useMap3D$1, g as useMarker3D$1 } from './chunks/use-map-3d-BOXDWF5P.mjs';
export { t as APIProvider, V as VERSION, v as __resetModuleState } from './chunks/use-map-3d-BOXDWF5P.mjs';
import React__default, { useEffect, useLayoutEffect, useRef, useState, useContext, useMemo, forwardRef, useImperativeHandle, Children, useCallback } from 'react';
import { createPortal } from 'react-dom';
export { S as StaticMap, c as createStaticMapsUrl } from './chunks/static-map-LbkIhf34.mjs';

/**
 * Copy of the `google.maps.CollisionBehavior` constants.
 * They have to be duplicated here since we can't wait for the maps API to load
 * to be able to use them.
 */
const CollisionBehavior = {
    REQUIRED: 'REQUIRED',
    REQUIRED_AND_HIDES_OPTIONAL: 'REQUIRED_AND_HIDES_OPTIONAL',
    OPTIONAL_AND_HIDES_LOWER_PRIORITY: 'OPTIONAL_AND_HIDES_LOWER_PRIORITY'
};
/**
 * AltitudeMode for specifying how altitude is interpreted for 3D elements.
 * This mirrors google.maps.maps3d.AltitudeMode but is available without waiting
 * for the API to load.
 */
const AltitudeMode = {
    /** Allows to express objects relative to the average mean sea level. */
    ABSOLUTE: 'ABSOLUTE',
    /** Allows to express objects placed on the ground. */
    CLAMP_TO_GROUND: 'CLAMP_TO_GROUND',
    /** Allows to express objects relative to the ground surface. */
    RELATIVE_TO_GROUND: 'RELATIVE_TO_GROUND',
    /** Allows to express objects relative to the highest of ground+building+water surface. */
    RELATIVE_TO_MESH: 'RELATIVE_TO_MESH'
};

/**
 * Sets up effects to bind event-handlers for all event-props in MapEventProps.
 * @internal
 */
function useMapEvents(map, props) {
    // note: calling a useEffect hook from within a loop is prohibited by the
    // rules of hooks, but it's ok here since it's unconditional and the number
    // and order of iterations is always strictly the same.
    // (see https://legacy.reactjs.org/docs/hooks-rules.html)
    for (const propName of eventPropNames) {
        // fixme: this cast is essentially a 'trust me, bro' for typescript, but
        //   a proper solution seems way too complicated right now
        const handler = props[propName];
        const eventType = propNameToEventType[propName];
        // eslint-disable-next-line react-hooks/rules-of-hooks
        useEffect(() => {
            if (!map)
                return;
            if (!handler)
                return;
            const listener = google.maps.event.addListener(map, eventType, (ev) => {
                const mapEvent = createMapEvent(eventType, map, ev);
                if (mapEvent)
                    handler(mapEvent);
            });
            return () => listener.remove();
        }, [map, eventType, handler]);
    }
}
/**
 * Create the wrapped map-events used for the event-props.
 * @param type the event type as it is specified to the maps api
 * @param map the map instance the event originates from
 * @param srcEvent the source-event if there is one.
 */
function createMapEvent(type, map, srcEvent) {
    var _a;
    const ev = {
        type,
        map,
        detail: {},
        stoppable: false,
        stop: () => { }
    };
    if (cameraEventTypes.includes(type)) {
        const camEvent = ev;
        const center = map.getCenter();
        const zoom = map.getZoom();
        const heading = map.getHeading() || 0;
        const tilt = map.getTilt() || 0;
        const bounds = map.getBounds();
        if (!center || !bounds || !Number.isFinite(zoom)) {
            console.warn('[createEvent] at least one of the values from the map ' +
                'returned undefined. This is not expected to happen. Please ' +
                'report an issue at https://github.com/visgl/react-google-maps/issues/new');
            return null;
        }
        camEvent.detail = {
            center: center.toJSON(),
            zoom: zoom,
            heading: heading,
            tilt: tilt,
            bounds: bounds.toJSON()
        };
        return camEvent;
    }
    else if (mouseEventTypes.includes(type)) {
        if (!srcEvent)
            throw new Error('[createEvent] mouse events must provide a srcEvent');
        const mouseEvent = ev;
        mouseEvent.domEvent = srcEvent.domEvent;
        mouseEvent.stoppable = true;
        mouseEvent.stop = () => srcEvent.stop();
        mouseEvent.detail = {
            latLng: ((_a = srcEvent.latLng) === null || _a === void 0 ? void 0 : _a.toJSON()) || null,
            placeId: srcEvent.placeId
        };
        return mouseEvent;
    }
    return ev;
}
/**
 * maps the camelCased names of event-props to the corresponding event-types
 * used in the maps API.
 */
const propNameToEventType = {
    onBoundsChanged: 'bounds_changed',
    onCenterChanged: 'center_changed',
    onClick: 'click',
    onContextmenu: 'contextmenu',
    onDblclick: 'dblclick',
    onDrag: 'drag',
    onDragend: 'dragend',
    onDragstart: 'dragstart',
    onHeadingChanged: 'heading_changed',
    onIdle: 'idle',
    onIsFractionalZoomEnabledChanged: 'isfractionalzoomenabled_changed',
    onMapCapabilitiesChanged: 'mapcapabilities_changed',
    onMapTypeIdChanged: 'maptypeid_changed',
    onMousemove: 'mousemove',
    onMouseout: 'mouseout',
    onMouseover: 'mouseover',
    onProjectionChanged: 'projection_changed',
    onRenderingTypeChanged: 'renderingtype_changed',
    onTilesLoaded: 'tilesloaded',
    onTiltChanged: 'tilt_changed',
    onZoomChanged: 'zoom_changed',
    // note: onCameraChanged is an alias for the bounds_changed event,
    // since that is going to be fired in every situation where the camera is
    // updated.
    onCameraChanged: 'bounds_changed'
};
const cameraEventTypes = [
    'bounds_changed',
    'center_changed',
    'heading_changed',
    'tilt_changed',
    'zoom_changed'
];
const mouseEventTypes = [
    'click',
    'contextmenu',
    'dblclick',
    'mousemove',
    'mouseout',
    'mouseover'
];
const eventPropNames = Object.keys(propNameToEventType);

const mapOptionKeys = new Set([
    'backgroundColor',
    'clickableIcons',
    'controlSize',
    'disableDefaultUI',
    'disableDoubleClickZoom',
    'draggable',
    'draggableCursor',
    'draggingCursor',
    'fullscreenControl',
    'fullscreenControlOptions',
    'gestureHandling',
    'headingInteractionEnabled',
    'isFractionalZoomEnabled',
    'keyboardShortcuts',
    'mapTypeControl',
    'mapTypeControlOptions',
    'mapTypeId',
    'maxZoom',
    'minZoom',
    'noClear',
    'panControl',
    'panControlOptions',
    'restriction',
    'rotateControl',
    'rotateControlOptions',
    'scaleControl',
    'scaleControlOptions',
    'scrollwheel',
    'streetView',
    'streetViewControl',
    'streetViewControlOptions',
    'styles',
    'tiltInteractionEnabled',
    'zoomControl',
    'zoomControlOptions'
]);
/**
 * Internal hook to update the map-options when props are changed.
 *
 * @param map the map instance
 * @param mapProps the props to update the map-instance with
 * @internal
 */
function useMapOptions(map, mapProps) {
    /* eslint-disable react-hooks/exhaustive-deps --
     *
     * The following effects aren't triggered when the map is changed.
     * In that case, the values will be or have been passed to the map
     * constructor via mapOptions.
     */
    const mapOptions = {};
    const keys = Object.keys(mapProps);
    for (const key of keys) {
        if (!mapOptionKeys.has(key))
            continue;
        mapOptions[key] = mapProps[key];
    }
    // update the map options when mapOptions is changed
    // Note: due to the destructuring above, mapOptions will be seen as changed
    //   with every re-render, so we're assuming the maps-api will properly
    //   deal with unchanged option-values passed into setOptions.
    useDeepCompareEffect(() => {
        if (!map)
            return;
        map.setOptions(mapOptions);
    }, [mapOptions]);
    /* eslint-enable react-hooks/exhaustive-deps */
}

/**
 * Internal hook that updates the camera when deck.gl viewState changes.
 * @internal
 */
function useDeckGLCameraUpdate(map, props) {
    const { viewport, viewState } = props;
    const isDeckGlControlled = !!viewport;
    useLayoutEffect(() => {
        if (!map || !viewState)
            return;
        const { latitude, longitude, bearing: heading, pitch: tilt, zoom } = viewState;
        map.moveCamera({
            center: { lat: latitude, lng: longitude },
            heading,
            tilt,
            zoom: zoom + 1
        });
    }, [map, viewState]);
    return isDeckGlControlled;
}

function isLatLngLiteral(obj) {
    if (!obj || typeof obj !== 'object')
        return false;
    if (!('lat' in obj && 'lng' in obj))
        return false;
    return Number.isFinite(obj.lat) && Number.isFinite(obj.lng);
}
function latLngEquals(a, b) {
    if (!a || !b)
        return false;
    const A = toLatLngLiteral(a);
    const B = toLatLngLiteral(b);
    if (A.lat !== B.lat || A.lng !== B.lng)
        return false;
    return true;
}
function toLatLngLiteral(obj) {
    if (isLatLngLiteral(obj))
        return obj;
    return obj.toJSON();
}
function toLatLngBoundsLiteral(obj) {
    if ('north' in obj && 'south' in obj && 'east' in obj && 'west' in obj) {
        return obj;
    }
    const ne = obj.getNorthEast().toJSON();
    const sw = obj.getSouthWest().toJSON();
    return {
        north: ne.lat,
        east: ne.lng,
        south: sw.lat,
        west: sw.lng
    };
}
function boundsEquals(a, b) {
    if (!a || !b)
        return false;
    const A = toLatLngBoundsLiteral(a);
    const B = toLatLngBoundsLiteral(b);
    return (A.north === B.north &&
        A.south === B.south &&
        A.east === B.east &&
        A.west === B.west);
}
/**
 * Compares two paths (arrays of LatLng points) for equality.
 */
function pathEquals(a, b) {
    if (!a || !b)
        return a === b;
    const arrayB = 'getArray' in b ? b.getArray() : b;
    if (a.length !== arrayB.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (!latLngEquals(a[i], arrayB[i]))
            return false;
    }
    return true;
}
/**
 * Compares two arrays of paths (for Polygon) for equality.
 */
function pathsEquals(a, b) {
    if (!a || !b)
        return a === b;
    const arrayB = 'getArray' in b ? b.getArray().map(inner => inner.getArray()) : b;
    if (a.length !== arrayB.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (!pathEquals(a[i], arrayB[i]))
            return false;
    }
    return true;
}

function useMapCameraParams(map, cameraStateRef, mapProps) {
    const center = mapProps.center ? toLatLngLiteral(mapProps.center) : null;
    let lat = null;
    let lng = null;
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
        lat = center.lat;
        lng = center.lng;
    }
    const zoom = Number.isFinite(mapProps.zoom)
        ? mapProps.zoom
        : null;
    const heading = Number.isFinite(mapProps.heading)
        ? mapProps.heading
        : null;
    const tilt = Number.isFinite(mapProps.tilt)
        ? mapProps.tilt
        : null;
    // the following effect runs for every render of the map component and checks
    // if there are differences between the known state of the map instance
    // (cameraStateRef, which is updated by all bounds_changed events) and the
    // desired state in the props.
    useLayoutEffect(() => {
        if (!map)
            return;
        const nextCamera = {};
        let needsUpdate = false;
        if (lat !== null &&
            lng !== null &&
            (cameraStateRef.current.center.lat !== lat ||
                cameraStateRef.current.center.lng !== lng)) {
            nextCamera.center = { lat, lng };
            needsUpdate = true;
        }
        if (zoom !== null && cameraStateRef.current.zoom !== zoom) {
            nextCamera.zoom = zoom;
            needsUpdate = true;
        }
        if (heading !== null && cameraStateRef.current.heading !== heading) {
            nextCamera.heading = heading;
            needsUpdate = true;
        }
        if (tilt !== null && cameraStateRef.current.tilt !== tilt) {
            nextCamera.tilt = tilt;
            needsUpdate = true;
        }
        if (needsUpdate) {
            map.moveCamera(nextCamera);
        }
    });
}

const AuthFailureMessage = () => {
    const style = {
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        zIndex: 999,
        display: 'flex',
        flexFlow: 'column nowrap',
        textAlign: 'center',
        justifyContent: 'center',
        fontSize: '.8rem',
        color: 'rgba(0,0,0,0.6)',
        background: '#dddddd',
        padding: '1rem 1.5rem'
    };
    return (React__default.createElement("div", { style: style },
        React__default.createElement("h2", null, "Error: AuthFailure"),
        React__default.createElement("p", null,
            "A problem with your API key prevents the map from rendering correctly. Please make sure the value of the ",
            React__default.createElement("code", null, "APIProvider.apiKey"),
            " prop is correct. Check the error-message in the console for further details.")));
};

function handleBoundsChange(map, ref) {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const heading = map.getHeading() || 0;
    const tilt = map.getTilt() || 0;
    if (!center || !Number.isFinite(zoom)) {
        console.warn('[useTrackedCameraState] at least one of the values from the map ' +
            'returned undefined. This is not expected to happen. Please ' +
            'report an issue at https://github.com/visgl/react-google-maps/issues/new');
        return;
    }
    Object.assign(ref.current, {
        center: center.toJSON(),
        zoom: zoom,
        heading: heading,
        tilt: tilt
    });
}
/**
 * Creates a mutable ref object to track the last known state of the map camera.
 * This is used in `useMapCameraParams` to reduce stuttering in normal operation
 * by avoiding updates of the map camera with values that have already been processed.
 */
function useTrackedCameraStateRef(map) {
    const forceUpdate = useForceUpdate();
    const ref = useRef({
        center: { lat: 0, lng: 0 },
        heading: 0,
        tilt: 0,
        zoom: 0
    });
    // Record camera state with every bounds_changed event dispatched by the map.
    // This data is used to prevent feeding these values back to the
    // map-instance when a typical "controlled component" setup (state variable is
    // fed into and updated by the map).
    useEffect(() => {
        if (!map)
            return;
        const listener = google.maps.event.addListener(map, 'bounds_changed', () => {
            handleBoundsChange(map, ref);
            // When an event is occured, we have to update during the next cycle.
            // The application could decide to ignore the event and not update any
            // camera props of the map, meaning that in that case we will have to
            // 'undo' the change to the camera.
            forceUpdate();
        });
        return () => listener.remove();
    }, [map, forceUpdate]);
    return ref;
}

/**
 * Stores a stack of map-instances for each mapId. Whenever an
 * instance is used, it is removed from the stack while in use,
 * and returned to the stack when the component unmounts.
 * This allows us to correctly implement caching for multiple
 * maps om the same page, while reusing as much as possible.
 *
 * FIXME: while it should in theory be possible to reuse maps solely
 *   based on mapId/renderingType/colorScheme (as all other parameters can be
 *   changed at runtime), we don't yet have good enough tracking of options to
 *   reliably unset all the options that have been set.
 */
class CachedMapStack {
    static has(key) {
        return this.entries[key] && this.entries[key].length > 0;
    }
    static pop(key) {
        if (!this.entries[key])
            return null;
        return this.entries[key].pop() || null;
    }
    static push(key, value) {
        if (!this.entries[key])
            this.entries[key] = [];
        this.entries[key].push(value);
    }
}
CachedMapStack.entries = {};
/**
 * The main hook takes care of creating map-instances and registering them in
 * the api-provider context.
 * @return a tuple of the map-instance created (or null) and the callback
 *   ref that will be used to pass the map-container into this hook.
 * @internal
 */
function useMapInstance(props, context) {
    const apiIsLoaded = useApiIsLoaded();
    const [map, setMap] = useState(null);
    const [container, containerRef] = useCallbackRef();
    const cameraStateRef = useTrackedCameraStateRef(map);
    const { id, defaultBounds, defaultCenter, defaultZoom, defaultHeading, defaultTilt, reuseMaps, renderingType, colorScheme } = props, mapOptions = __rest(props, ["id", "defaultBounds", "defaultCenter", "defaultZoom", "defaultHeading", "defaultTilt", "reuseMaps", "renderingType", "colorScheme"]);
    const hasZoom = props.zoom !== undefined || props.defaultZoom !== undefined;
    const hasCenter = props.center !== undefined || props.defaultCenter !== undefined;
    if (!defaultBounds && (!hasZoom || !hasCenter)) {
        console.warn('<Map> component is missing configuration. ' +
            'You have to provide zoom and center (via the `zoom`/`defaultZoom` and ' +
            '`center`/`defaultCenter` props) or specify the region to show using ' +
            '`defaultBounds`. See ' +
            'https://visgl.github.io/react-google-maps/docs/api-reference/components/map#required');
    }
    // apply default camera props if available and not overwritten by controlled props
    if (!mapOptions.center && defaultCenter)
        mapOptions.center = defaultCenter;
    if (!mapOptions.zoom && Number.isFinite(defaultZoom))
        mapOptions.zoom = defaultZoom;
    if (!mapOptions.heading && Number.isFinite(defaultHeading))
        mapOptions.heading = defaultHeading;
    if (!mapOptions.tilt && Number.isFinite(defaultTilt))
        mapOptions.tilt = defaultTilt;
    // Handle internalUsageAttributionIds
    const customIds = mapOptions.internalUsageAttributionIds;
    if (customIds == null) {
        // Not specified - use context default (which may be null if disabled)
        mapOptions.internalUsageAttributionIds =
            context.internalUsageAttributionIds;
    }
    else {
        // Merge context defaults with custom IDs
        mapOptions.internalUsageAttributionIds = [
            ...(context.internalUsageAttributionIds || []),
            ...customIds
        ];
    }
    for (const key of Object.keys(mapOptions))
        if (mapOptions[key] === undefined)
            delete mapOptions[key];
    const savedMapStateRef = useRef(undefined);
    // kept up to date on every render so the effect below (which intentionally
    // doesn't list reuseMaps as a dependency) always sees the latest value,
    // both when creating a map and in its cleanup function on unmount.
    const reuseMapsRef = useRef(reuseMaps);
    useEffect(() => {
        reuseMapsRef.current = reuseMaps;
    }, [reuseMaps]);
    // create the map instance and register it in the context
    useEffect(() => {
        if (!container || !apiIsLoaded)
            return;
        const { addMapInstance, removeMapInstance } = context;
        // note: colorScheme (upcoming feature) isn't yet in the typings, remove once that is fixed:
        const { mapId } = props;
        const cacheKey = `${mapId || 'default'}:${renderingType || 'default'}:${colorScheme || 'LIGHT'}`;
        let mapDiv;
        let map;
        // a cached map can end up in a broken state (e.g. when the initial
        // map-creation failed because the Maps JavaScript API didn't load
        // correctly). In that case `getDiv()` doesn't return a usable DOM node,
        // so we have to discard the cached instance instead of trying to reuse it.
        const cachedMap = reuseMapsRef.current && CachedMapStack.has(cacheKey)
            ? CachedMapStack.pop(cacheKey)
            : null;
        const cachedMapDiv = cachedMap === null || cachedMap === void 0 ? void 0 : cachedMap.getDiv();
        const reusedMap = cachedMap && cachedMapDiv instanceof Node ? cachedMap : null;
        if (reusedMap) {
            map = reusedMap;
            mapDiv = cachedMapDiv;
            container.appendChild(mapDiv);
            map.setOptions(mapOptions);
            // detaching the element from the DOM sometimes causes the map to collapse
            // and no longer render tiles that should be in view after re-attaching it.
            // Triggering moveCamera after remounting should trigger a re-layout of
            // the map.
            setTimeout(() => map.moveCamera({}), 0);
        }
        else {
            // discard a broken cached instance so it doesn't get pushed back
            if (cachedMap)
                google.maps.event.clearInstanceListeners(cachedMap);
            mapDiv = document.createElement('div');
            mapDiv.style.height = '100%';
            container.appendChild(mapDiv);
            map = new google.maps.Map(mapDiv, Object.assign(Object.assign(Object.assign({}, mapOptions), (renderingType
                ? { renderingType: renderingType }
                : {})), (colorScheme
                ? { colorScheme: colorScheme }
                : {})));
        }
        setMap(map);
        addMapInstance(map, id);
        if (defaultBounds) {
            const { padding } = defaultBounds, defBounds = __rest(defaultBounds, ["padding"]);
            map.fitBounds(defBounds, padding);
        }
        // prevent map not rendering due to missing configuration
        else if (!hasZoom || !hasCenter) {
            map.fitBounds({ east: 180, west: -180, south: -90, north: 90 });
        }
        // the savedMapState is used to restore the camera parameters when the mapId is changed
        if (savedMapStateRef.current) {
            const { mapId: savedMapId, cameraState: savedCameraState } = savedMapStateRef.current;
            if (savedMapId !== mapId) {
                map.moveCamera(savedCameraState);
            }
        }
        return () => {
            savedMapStateRef.current = {
                mapId,
                // eslint-disable-next-line react-hooks/exhaustive-deps
                cameraState: cameraStateRef.current
            };
            // detach the map-div from the dom
            mapDiv.remove();
            if (reuseMapsRef.current) {
                // push back on the stack
                CachedMapStack.push(cacheKey, map);
            }
            else {
                // remove all event-listeners to minimize the possibility of memory-leaks
                google.maps.event.clearInstanceListeners(map);
            }
            setMap(null);
            removeMapInstance(id);
        };
    }, 
    // some dependencies are ignored in the list below:
    //  - defaultBounds and the default* camera props will only be used once, and
    //    changes should be ignored
    //  - mapOptions has special hooks that take care of updating the options
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
        container,
        apiIsLoaded,
        id,
        // these props can't be changed after initialization and require a new
        // instance to be created
        props.mapId,
        props.renderingType,
        props.colorScheme
    ]);
    return [map, containerRef, cameraStateRef];
}

const GoogleMapsContext = React__default.createContext(null);
// ColorScheme and RenderingType are redefined here to make them usable before the
// maps API has been fully loaded.
const ColorScheme = {
    DARK: 'DARK',
    LIGHT: 'LIGHT',
    FOLLOW_SYSTEM: 'FOLLOW_SYSTEM'
};
const RenderingType = {
    VECTOR: 'VECTOR',
    RASTER: 'RASTER',
    UNINITIALIZED: 'UNINITIALIZED'
};
const Map = (props) => {
    const { children, id, className, style } = props;
    const context = useContext(APIProviderContext);
    const loadingStatus = useApiLoadingStatus();
    if (!context) {
        throw new Error('<Map> can only be used inside an <ApiProvider> component.');
    }
    const [map, mapRef, cameraStateRef] = useMapInstance(props, context);
    useMapCameraParams(map, cameraStateRef, props);
    useMapEvents(map, props);
    useMapOptions(map, props);
    const isDeckGlControlled = useDeckGLCameraUpdate(map, props);
    const isControlledExternally = !!props.controlled;
    // disable interactions with the map for externally controlled maps
    useEffect(() => {
        if (!map)
            return;
        // fixme: this doesn't seem to belong here (and it's mostly there for convenience anyway).
        //   The reasoning is that a deck.gl canvas will be put on top of the map, rendering
        //   any default map controls pretty much useless
        if (isDeckGlControlled) {
            map.setOptions({ disableDefaultUI: true });
        }
        // disable all control-inputs when the map is controlled externally
        if (isDeckGlControlled || isControlledExternally) {
            map.setOptions({
                gestureHandling: 'none',
                keyboardShortcuts: false
            });
        }
        return () => {
            map.setOptions({
                gestureHandling: props.gestureHandling,
                keyboardShortcuts: props.keyboardShortcuts
            });
        };
    }, [
        map,
        isDeckGlControlled,
        isControlledExternally,
        props.gestureHandling,
        props.keyboardShortcuts
    ]);
    // setup a stable cameraOptions object that can be used as dependency
    const center = props.center ? toLatLngLiteral(props.center) : null;
    let lat = null;
    let lng = null;
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
        lat = center.lat;
        lng = center.lng;
    }
    const cameraOptions = useMemo(() => {
        var _a, _b, _c;
        return {
            center: { lat: lat !== null && lat !== void 0 ? lat : 0, lng: lng !== null && lng !== void 0 ? lng : 0 },
            zoom: (_a = props.zoom) !== null && _a !== void 0 ? _a : 0,
            heading: (_b = props.heading) !== null && _b !== void 0 ? _b : 0,
            tilt: (_c = props.tilt) !== null && _c !== void 0 ? _c : 0
        };
    }, [lat, lng, props.zoom, props.heading, props.tilt]);
    // externally controlled mode: reject all camera changes that don't correspond to changes in props
    useLayoutEffect(() => {
        if (!map || !isControlledExternally)
            return;
        map.moveCamera(cameraOptions);
        const listener = map.addListener('bounds_changed', () => {
            map.moveCamera(cameraOptions);
        });
        return () => listener.remove();
    }, [map, isControlledExternally, cameraOptions]);
    const combinedStyle = useMemo(() => (Object.assign({ width: '100%', height: '100%', position: 'relative', 
        // when using deckgl, the map should be sent to the back
        zIndex: isDeckGlControlled ? -1 : 0 }, style)), [style, isDeckGlControlled]);
    const contextValue = useMemo(() => ({ map }), [map]);
    if (loadingStatus === APILoadingStatus.AUTH_FAILURE) {
        return (React__default.createElement("div", { style: Object.assign({ position: 'relative' }, (className ? {} : combinedStyle)), className: className },
            React__default.createElement(AuthFailureMessage, null)));
    }
    return (React__default.createElement("div", Object.assign({ ref: mapRef, "data-testid": 'map', style: className ? undefined : combinedStyle, className: className }, (id ? { id } : {})), map ? (React__default.createElement(GoogleMapsContext.Provider, { value: contextValue }, children)) : null));
};
// The deckGLViewProps flag here indicates to deck.gl that the Map component is
// able to handle viewProps from deck.gl when deck.gl is used to control the map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Map.deckGLViewProps = true;

/**
 * Retrieves a map-instance from the context. This is either an instance
 * identified by id or the parent map instance if no id is specified.
 * Returns null if neither can be found.
 */
const useMap = (id = null) => {
    const ctx = useContext(APIProviderContext);
    const { map } = useContext(GoogleMapsContext) || {};
    if (ctx === null) {
        logErrorOnce('useMap(): failed to retrieve APIProviderContext. ' +
            'Make sure that the <APIProvider> component exists and that the ' +
            'component you are calling `useMap()` from is a sibling of the ' +
            '<APIProvider>.');
        return null;
    }
    const { mapInstances } = ctx;
    // if an id is specified, the corresponding map or null is returned
    if (id !== null)
        return mapInstances[id] || null;
    // otherwise, return the closest ancestor
    if (map)
        return map;
    // finally, return the default map instance
    return mapInstances['default'] || null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const noop = () => { };
/**
 * Internally used to bind events to Maps JavaScript API objects.
 * @internal
 */
function useMapsEventListener(target, name, callback) {
    const eventFn = useEffectEvent(callback !== null && callback !== void 0 ? callback : noop);
    const isCallbackDefined = Boolean(callback);
    useEffect(() => {
        if (!target || !name || !isCallbackDefined)
            return;
        const listener = google.maps.event.addListener(target, name, eventFn);
        return () => listener.remove();
    }, [target, name, isCallbackDefined]);
}

// Global style manager to track rendered styles and avoid duplicates
class GlobalStyleManager {
    constructor() {
        this.renderedStyles = new Set();
        this.styleElement = null;
    }
    getStyleElement() {
        if (!this.styleElement) {
            this.styleElement = document.createElement('style');
            this.styleElement.setAttribute('data-rgm-anchor-styles', '');
            document.head.appendChild(this.styleElement);
        }
        return this.styleElement;
    }
    addAdvancedMarkerPointerEventsOverwrite() {
        if (this.renderedStyles.has('marker-pointer-events')) {
            return;
        }
        const styleElement = this.getStyleElement();
        styleElement.textContent += `
      gmp-advanced-marker[data-origin='rgm'] {
        pointer-events: none !important;
      }
    `;
        this.renderedStyles.add('marker-pointer-events');
    }
    cleanup() {
        if (this.styleElement) {
            this.styleElement.remove();
            this.styleElement = null;
            this.renderedStyles.clear();
        }
    }
}
const globalStyleManager = new GlobalStyleManager();

function isVersionGreaterEqual(major, minor) {
    var _a;
    if (!((_a = google === null || google === void 0 ? void 0 : google.maps) === null || _a === void 0 ? void 0 : _a.version))
        return undefined;
    const version = google.maps.version.split('.');
    const currentMajor = parseInt(version[0], 10);
    const currentMinor = parseInt(version[1], 10);
    return (currentMajor > major || (currentMajor === major && currentMinor >= minor));
}

const AdvancedMarkerContext = React__default.createContext(null);
// [xPosition, yPosition] when the top left corner is [0, 0]
/**
 * @deprecated Using `anchorPosition` is deprecated.
 *   Use `anchorLeft` and `anchorTop` instead.
 */
const AdvancedMarkerAnchorPoint = {
    TOP_LEFT: ['0%', '0%'],
    TOP_CENTER: ['50%', '0%'],
    TOP: ['50%', '0%'],
    TOP_RIGHT: ['100%', '0%'],
    LEFT_CENTER: ['0%', '50%'],
    LEFT_TOP: ['0%', '0%'],
    LEFT: ['0%', '50%'],
    LEFT_BOTTOM: ['0%', '100%'],
    RIGHT_TOP: ['100%', '0%'],
    RIGHT: ['100%', '50%'],
    RIGHT_CENTER: ['100%', '50%'],
    RIGHT_BOTTOM: ['100%', '100%'],
    BOTTOM_LEFT: ['0%', '100%'],
    BOTTOM_CENTER: ['50%', '100%'],
    BOTTOM: ['50%', '100%'],
    BOTTOM_RIGHT: ['100%', '100%'],
    CENTER: ['50%', '50%']
};
const AdvancedMarker = forwardRef((props, ref) => {
    const { children, style, className, anchorPoint } = props;
    const [marker, contentContainer] = useAdvancedMarker(props);
    const advancedMarkerContextValue = useMemo(() => (marker ? { marker } : null), [marker]);
    useImperativeHandle(ref, () => marker, [marker]);
    if (!contentContainer)
        return null;
    return (React__default.createElement(AdvancedMarkerContext.Provider, { value: advancedMarkerContextValue }, createPortal(React__default.createElement(MarkerContent, { anchorPoint: anchorPoint, styles: style, className: className }, children), contentContainer)));
});
AdvancedMarker.displayName = 'AdvancedMarker';
function useAdvancedMarkerRef() {
    const [marker, setMarker] = useState(null);
    const refCallback = useCallback((m) => {
        setMarker(m);
    }, []);
    return [refCallback, marker];
}
function isAdvancedMarker(marker) {
    return (marker.content !== undefined);
}
function isElementNode(node) {
    return node.nodeType === Node.ELEMENT_NODE;
}
const MarkerContent = ({ children, styles, className }) => {
    /* AdvancedMarker div that user can give styles and classes */
    return (React__default.createElement("div", { className: className, style: styles }, children));
};
function useAdvancedMarker(props) {
    const [marker, setMarker] = useState(null);
    const [contentContainer, setContentContainer] = useState(null);
    const map = useMap();
    const markerLibrary = useMapsLibrary('marker');
    const { children, onClick, onKeyDown, onKeyUp, className, onMouseEnter, onMouseLeave, onDrag, onDragStart, onDragEnd, collisionBehavior, clickable, draggable, position, title, zIndex, anchorPoint, anchorLeft, anchorTop } = props;
    const numChildren = Children.count(children);
    // create an AdvancedMarkerElement instance and add it to the map once available
    useEffect(() => {
        if (!map || !markerLibrary)
            return;
        const newMarker = new markerLibrary.AdvancedMarkerElement();
        newMarker.map = map;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setMarker(newMarker);
        // create the container for marker content if there are children
        let contentElement = null;
        if (numChildren > 0) {
            contentElement = document.createElement('div');
            newMarker.content = contentElement;
            setContentContainer(contentElement);
        }
        return () => {
            newMarker.map = null;
            contentElement === null || contentElement === void 0 ? void 0 : contentElement.remove();
            setMarker(null);
            setContentContainer(null);
        };
    }, [map, markerLibrary, numChildren]);
    // When no children are present we don't have our own wrapper div
    // which usually gets the user provided className. In this case
    // we set the className directly on the marker.content element that comes
    // with the AdvancedMarker.
    useEffect(() => {
        if (!(marker === null || marker === void 0 ? void 0 : marker.content) || !isElementNode(marker.content) || numChildren > 0)
            return;
        marker.content.className = className !== null && className !== void 0 ? className : '';
    }, [marker, className, numChildren]);
    useAdvancedMarkerAnchoring(marker, anchorPoint, anchorLeft, anchorTop, numChildren > 0);
    // copy other props
    usePropBinding(marker, 'position', position);
    usePropBinding(marker, 'title', title !== null && title !== void 0 ? title : '');
    usePropBinding(marker, 'zIndex', zIndex);
    usePropBinding(marker, 'collisionBehavior', collisionBehavior);
    // set gmpDraggable from props (when unspecified, it's true if any drag-event
    // callbacks are specified)
    useEffect(() => {
        if (!marker)
            return;
        if (draggable !== undefined)
            marker.gmpDraggable = draggable;
        else if (onDrag || onDragStart || onDragEnd)
            marker.gmpDraggable = true;
        else
            marker.gmpDraggable = false;
    }, [marker, draggable, onDrag, onDragEnd, onDragStart]);
    // set gmpClickable from props (when unspecified, it's true if any interactive
    // event callbacks are specified)
    useEffect(() => {
        if (!marker)
            return;
        // when clickable is defined, we will always use its value for gmpClickable.
        // otherwise we auto-detect based on existing event-handlers.
        const gmpClickable = clickable !== undefined
            ? clickable
            : Boolean(onClick) ||
                Boolean(onKeyDown) ||
                Boolean(onKeyUp) ||
                Boolean(onMouseEnter) ||
                Boolean(onMouseLeave);
        // gmpClickable is only available in beta version of the
        // maps api (as of 2024-10-10)
        marker.gmpClickable = gmpClickable;
        // keep pointer/cursor styles in sync for markers with custom content.
        // Non-clickable custom HTML must disable pointer targeting explicitly so
        // interactions fall through to the map underneath.
        if ((marker === null || marker === void 0 ? void 0 : marker.content) && isElementNode(marker.content)) {
            marker.content.style.pointerEvents = gmpClickable ? 'all' : 'none';
            marker.content.style.cursor = gmpClickable && onClick ? 'pointer' : '';
        }
    }, [
        marker,
        clickable,
        onClick,
        onKeyDown,
        onKeyUp,
        onMouseEnter,
        onMouseLeave
    ]);
    useMapsEventListener(marker, 'drag', onDrag);
    useMapsEventListener(marker, 'dragstart', onDragStart);
    useMapsEventListener(marker, 'dragend', onDragEnd);
    useDomEventListener(marker, 'gmp-click', onClick);
    useDomEventListener(marker, 'keydown', onKeyDown);
    useDomEventListener(marker, 'keyup', onKeyUp);
    useDomEventListener(marker, 'mouseenter', onMouseEnter);
    useDomEventListener(marker, 'mouseleave', onMouseLeave);
    return [marker, contentContainer];
}
function useAdvancedMarkerAnchoring(marker, anchorPoint, anchorLeft, anchorTop, hasChildren) {
    useEffect(() => {
        if (!marker || !hasChildren)
            return;
        // The anchorLeft and anchorTop options are available since version 3.62.9c
        // With the release of 3.65 (~May 2026) there will no longer be a version
        // that doesn't support it.
        const anchorOptionsSupported = isVersionGreaterEqual(3, 62);
        const contentElement = marker.content;
        if (!contentElement || !isElementNode(contentElement))
            return;
        if (anchorLeft !== undefined || anchorTop !== undefined) {
            if (!anchorOptionsSupported) {
                console.warn('AdvancedMarker: The anchorLeft and anchorTop props are only supported ' +
                    'in Google Maps API version 3.62 and above. ' +
                    `The current version is ${google.maps.version}.`);
            }
            marker.anchorLeft = anchorLeft;
            marker.anchorTop = anchorTop;
            // when anchorLeft and/or anchorTop are set, we'll ignore the anchorPoint
            if (anchorPoint !== undefined) {
                console.warn('AdvancedMarker: the anchorPoint prop is ignored when anchorLeft ' +
                    'and/or anchorTop are set.');
            }
            return;
        }
        if (anchorPoint !== undefined) {
            // TODO: add console.warn in a future version to inform about deprecation
            const [x, y] = anchorPoint !== null && anchorPoint !== void 0 ? anchorPoint : AdvancedMarkerAnchorPoint['BOTTOM'];
            // NOTE: since x and y can be any valid CSS length-percentage
            //   value, we need to use calc() to negate them.
            const translateX = `calc(-1 * ${x})`;
            const translateY = `calc(-1 * ${y})`;
            if (anchorOptionsSupported) {
                // implement anchorPoint using the new anchorLeft and anchorTop options
                marker.anchorLeft = translateX;
                marker.anchorTop = translateY;
                // reset transform from legacy implementation
                contentElement.style.transform = '';
            }
            else {
                // The "translate(50%, 100%)" counters and resets the default
                // anchoring of the advanced marker element from the api
                contentElement.style.transform = `translate(50%, 100%) translate(${translateX}, ${translateY})`;
                // data-origin is needed to identify the custom marker content in the
                // InfoWindow component as well as in the global CSS used to disable
                // the pointer event when anchor points are used in older Google Maps
                // versions.
                marker.dataset.origin = 'rgm';
                globalStyleManager.addAdvancedMarkerPointerEventsOverwrite();
            }
        }
    }, [marker, anchorPoint, anchorLeft, anchorTop, hasChildren]);
}

// `Object.hasOwn` is ES2022 and tsc does not downlevel built-ins, so it would
// break the ES2015 target. set-value-for-styles.ts uses the same call.
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
/**
 * The value written to unset an option that is no longer present.
 *
 * Every property of the maps API option types is declared as `T | null`, so
 * `null` is the value the API sanctions for "back to the default". `undefined`
 * only appears via the optional marker and has no documented meaning.
 *
 * @internal
 */
const UNSET = null;
/**
 * Returns the options that have to be written to bring an instance from
 * `trackedOptions` to `nextOptions`, or `null` when nothing changed.
 *
 * `trackedOptions` is what the caller believes is currently applied to the
 * instance, not the previous render's props. That distinction is what makes
 * removal work: a key that was applied earlier and is missing from
 * `nextOptions` is explicitly unset rather than silently left behind.
 *
 * The result is always a fresh object, so the caller's tracked state is never
 * handed on to the maps API.
 *
 * @internal
 */
function getChangedOptions(nextOptions, trackedOptions) {
    let changedOptions = null;
    const keys = new Set([
        ...Object.keys(trackedOptions),
        ...Object.keys(nextOptions)
    ]);
    for (const key of keys) {
        // a key that disappeared has to be written back to the default, and a key
        // that is present counts as changed even when both values read as
        // undefined, since it may never have been applied
        if (!hasOwn(nextOptions, key)) {
            changedOptions !== null && changedOptions !== void 0 ? changedOptions : (changedOptions = Object.create(null));
            // null is not assignable to an unconstrained T[keyof T]; see UNSET above
            changedOptions[key] = UNSET;
            continue;
        }
        if (hasOwn(trackedOptions, key) &&
            deepEqual(trackedOptions[key], nextOptions[key]))
            continue;
        changedOptions !== null && changedOptions !== void 0 ? changedOptions : (changedOptions = Object.create(null));
        changedOptions[key] = nextOptions[key];
    }
    return changedOptions;
}
/**
 * Copies an options object deeply enough that nested values are not aliased by
 * the caller's.
 *
 * A shallow copy shares nested values with the props, so an `icons` array
 * mutated in place is compared against itself and reported unchanged. That only
 * matters once some other option also changes, since `useMemoized` otherwise
 * masks an in-place mutation before the hook runs at all.
 *
 * Plain objects and arrays are copied; anything else, including maps API
 * instances, is kept by reference.
 *
 * @internal
 */
function snapshotOptions(value) {
    if (Array.isArray(value))
        return value.map(entry => snapshotOptions(entry));
    if (value === null || typeof value !== 'object')
        return value;
    // only plain objects, so class instances are not mangled by copying
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype)
        return value;
    const copy = {};
    for (const key of Object.keys(value))
        copy[key] = snapshotOptions(value[key]);
    return copy;
}

/**
 * The options believed to be applied to each object, keyed weakly so a
 * torn-down maps object is not kept alive and no cleanup is needed.
 */
const appliedOptionsByObject = new WeakMap();
/**
 * A drop-in replacement for `object.setOptions(options)` that writes only the
 * values that changed since the last call.
 *
 * `setOptions` is not a cheap setter. It applies every key it is given without
 * comparing against the current value, and on an editable shape each stroke or
 * fill key costs a redraw of the vertex handles, so re-sending an unchanged
 * option bag is measurably expensive on shapes with many vertices. Sending only
 * the changed subset is equivalent, since the API leaves unspecified options
 * untouched.
 *
 * Pass `alreadyApplied` when the object was just created with these options, so
 * they are recorded without being written a second time. The caller has to say
 * so: parent effects run after child effects, so an option can change in the
 * same commit that creates the object, and inferring that the current options
 * were applied would drop that change permanently.
 *
 * An object with nothing recorded is treated as having no options applied and
 * receives the full set, so a forgotten `alreadyApplied` costs a redundant
 * write rather than a missing one.
 *
 * @internal
 */
function setMapObjectOptions(object, options, { alreadyApplied = false } = {}) {
    var _a;
    if (alreadyApplied) {
        appliedOptionsByObject.set(object, snapshotOptions(options));
        return;
    }
    const appliedOptions = ((_a = appliedOptionsByObject.get(object)) !== null && _a !== void 0 ? _a : {});
    const changedOptions = getChangedOptions(options, appliedOptions);
    if (!changedOptions)
        return;
    object.setOptions(changedOptions);
    appliedOptionsByObject.set(object, snapshotOptions(options));
}

function useCircle(props) {
    var _a, _b, _c;
    const { onClick, onDrag, onDragStart, onDragEnd, onMouseOver, onMouseOut, onRadiusChanged, onCenterChanged, center, defaultCenter, radius, defaultRadius } = props, destructuredOptions = __rest(props, ["onClick", "onDrag", "onDragStart", "onDragEnd", "onMouseOver", "onMouseOut", "onRadiusChanged", "onCenterChanged", "center", "defaultCenter", "radius", "defaultRadius"]);
    const [circle, setCircle] = useState(null);
    const map = useMap();
    // Memoize options with automatic inference of clickable/draggable/editable
    const circleOptions = useMemoized(Object.assign(Object.assign({}, destructuredOptions), { clickable: (_a = destructuredOptions.clickable) !== null && _a !== void 0 ? _a : Boolean(onClick), draggable: (_b = destructuredOptions.draggable) !== null && _b !== void 0 ? _b : Boolean(onDrag || onDragStart || onDragEnd || onCenterChanged), editable: (_c = destructuredOptions.editable) !== null && _c !== void 0 ? _c : Boolean(onRadiusChanged) }), deepEqual);
    useEffect(() => {
        if (!map) {
            if (map === undefined)
                console.error('<Circle> has to be inside a Map component.');
            return;
        }
        const newCircle = new google.maps.Circle(Object.assign(Object.assign({}, circleOptions), { center: center !== null && center !== void 0 ? center : defaultCenter, radius: radius !== null && radius !== void 0 ? radius : defaultRadius }));
        // the options above are applied by now, so record them without writing
        setMapObjectOptions(newCircle, circleOptions, { alreadyApplied: true });
        newCircle.setMap(map);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setCircle(newCircle);
        return () => {
            newCircle.setMap(null);
            setCircle(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- circle options are handled separately to avoid recreating the instance
    }, [map]);
    useMapsEventListener(circle, 'click', onClick);
    useMapsEventListener(circle, 'drag', onDrag);
    useMapsEventListener(circle, 'dragstart', onDragStart);
    useMapsEventListener(circle, 'dragend', onDragEnd);
    useMapsEventListener(circle, 'mouseover', onMouseOver);
    useMapsEventListener(circle, 'mouseout', onMouseOut);
    useMapsEventListener(circle, 'radius_changed', onRadiusChanged
        ? () => {
            const newRadius = circle === null || circle === void 0 ? void 0 : circle.getRadius();
            if (newRadius !== undefined)
                onRadiusChanged(newRadius);
        }
        : null);
    useMapsEventListener(circle, 'center_changed', onCenterChanged
        ? () => {
            onCenterChanged(circle === null || circle === void 0 ? void 0 : circle.getCenter());
        }
        : null);
    useEffect(() => {
        if (!circle)
            return;
        setMapObjectOptions(circle, circleOptions);
    }, [circle, circleOptions]);
    // Sync controlled center prop with the circle instance
    useEffect(() => {
        if (!circle || !center)
            return;
        if (!latLngEquals(center, circle.getCenter())) {
            circle.setCenter(center);
        }
    }, [circle, center]);
    // Sync controlled radius prop with the circle instance
    useEffect(() => {
        if (!circle || radius === undefined)
            return;
        if (radius !== circle.getRadius()) {
            circle.setRadius(radius);
        }
    }, [circle, radius]);
    return circle;
}
const Circle = forwardRef((props, ref) => {
    const circle = useCircle(props);
    useImperativeHandle(ref, () => circle, [circle]);
    return React__default.createElement(React__default.Fragment, null);
});
Circle.displayName = 'Circle';

/**
 * Component to render an Info Window with the Maps JavaScript API
 */
const InfoWindow = props => {
    const { 
    // content options
    children, headerContent, style, className, pixelOffset, 
    // open options
    anchor, shouldFocus, 
    // events
    onClose, onCloseClick } = props, 
    // other options
    volatileInfoWindowOptions = __rest(props, ["children", "headerContent", "style", "className", "pixelOffset", "anchor", "shouldFocus", "onClose", "onCloseClick"]);
    // ## create infowindow instance once the mapsLibrary is available.
    const mapsLibrary = useMapsLibrary('maps');
    const [infoWindow, setInfoWindow] = useState(null);
    const contentContainerRef = useRef(null);
    const headerContainerRef = useRef(null);
    const infoWindowOptions = useMemoized(volatileInfoWindowOptions, deepEqual);
    // ---- initial mount: create content- and header container, create and
    // configure the InfoWindow instance
    useEffect(() => {
        if (!mapsLibrary)
            return;
        contentContainerRef.current = document.createElement('div');
        headerContainerRef.current = document.createElement('div');
        const opts = Object.assign({}, infoWindowOptions);
        if (pixelOffset) {
            opts.pixelOffset = new google.maps.Size(pixelOffset[0], pixelOffset[1]);
        }
        if (headerContent) {
            // if headerContent is specified as string we can directly forward it,
            // otherwise we'll pass the element the portal will render into
            opts.headerContent =
                typeof headerContent === 'string'
                    ? headerContent
                    : headerContainerRef.current;
        }
        // intentionally shadowing the state variables here
        const infoWindow = new google.maps.InfoWindow(opts);
        infoWindow.setContent(contentContainerRef.current);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setInfoWindow(infoWindow);
        // unmount: remove infoWindow and content elements (note: close is called in a different effect-cleanup)
        return () => {
            var _a, _b;
            infoWindow.setContent(null);
            (_a = contentContainerRef.current) === null || _a === void 0 ? void 0 : _a.remove();
            (_b = headerContainerRef.current) === null || _b === void 0 ? void 0 : _b.remove();
            contentContainerRef.current = null;
            headerContainerRef.current = null;
            setInfoWindow(null);
        };
    }, 
    // `infoWindowOptions` and other props are missing from dependencies:
    //
    // We don't want to re-create the infowindow instance
    // when the options change.
    // Updating the options is handled in the useEffect below.
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapsLibrary]);
    // ---- update className and styles for `contentContainer`
    // prevStyleRef stores previously applied style properties, so they can be
    // removed when unset
    const prevStyleRef = useRef(null);
    useLayoutEffect(() => {
        if (!infoWindow || !contentContainerRef.current)
            return;
        setValueForStyles(contentContainerRef.current, style || null, prevStyleRef.current);
        prevStyleRef.current = style || null;
        if (className !== contentContainerRef.current.className)
            contentContainerRef.current.className = className || '';
    }, [infoWindow, className, style]);
    // ---- update options
    useEffect(() => {
        if (!infoWindow)
            return;
        const opts = Object.assign({}, infoWindowOptions);
        if (!pixelOffset) {
            opts.pixelOffset = null;
        }
        else {
            opts.pixelOffset = new google.maps.Size(pixelOffset[0], pixelOffset[1]);
        }
        if (!headerContent) {
            opts.headerContent = null;
        }
        else {
            opts.headerContent =
                typeof headerContent === 'string'
                    ? headerContent
                    : headerContainerRef.current;
        }
        infoWindow.setOptions(opts);
    }, 
    // dependency `infoWindow` isn't needed since options are also passed
    // to the constructor when a new infoWindow is created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [infoWindowOptions, pixelOffset, headerContent]);
    // ---- bind event handlers
    useMapsEventListener(infoWindow, 'close', onClose);
    useMapsEventListener(infoWindow, 'closeclick', onCloseClick);
    // ---- open info window when content and map are available
    const map = useMap();
    useEffect(() => {
        var _a;
        // `anchor === null` means an anchor is defined but not ready yet.
        if (!map || !infoWindow || anchor === null)
            return;
        const isOpenedWithAnchor = !!anchor;
        const openOptions = { map };
        if (anchor) {
            openOptions.anchor = anchor;
            // Only do the infowindow adjusting when dealing with an AdvancedMarker
            if (isAdvancedMarker(anchor) && anchor.content instanceof Element) {
                const anchorBcr = anchor === null || anchor === void 0 ? void 0 : anchor.getBoundingClientRect();
                // This checks whether or not the anchor has custom content with our own
                // div wrapper. If not, that means we have a regular AdvancedMarker without
                // children, or an AdvancedMarker that uses the anchorLeft/anchorTop props.
                // In that case we do not want to adjust the infowindow since it is all handled correctly
                // by the Google Maps API.
                if (anchorBcr && anchor.dataset.origin === 'rgm') {
                    // We can safely typecast here since we control that element and we know that
                    // it is a div
                    const anchorDomContent = (_a = anchor.content.firstElementChild) === null || _a === void 0 ? void 0 : _a.firstElementChild;
                    const contentBcr = anchorDomContent === null || anchorDomContent === void 0 ? void 0 : anchorDomContent.getBoundingClientRect();
                    // center infowindow above marker
                    const anchorOffsetX = contentBcr.x -
                        anchorBcr.x +
                        (contentBcr.width - anchorBcr.width) / 2;
                    const anchorOffsetY = contentBcr.y - anchorBcr.y;
                    const opts = Object.assign({}, infoWindowOptions);
                    opts.pixelOffset = new google.maps.Size(pixelOffset ? pixelOffset[0] + anchorOffsetX : anchorOffsetX, pixelOffset ? pixelOffset[1] + anchorOffsetY : anchorOffsetY);
                    infoWindow.setOptions(opts);
                }
            }
        }
        if (shouldFocus !== undefined) {
            openOptions.shouldFocus = shouldFocus;
        }
        infoWindow.open(openOptions);
        return () => {
            // Note: when the infowindow has an anchor, it will automatically show up again when the
            // anchor was removed from the map before infoWindow.close() is called but the it gets
            // added back to the map after that.
            // More information here: https://issuetracker.google.com/issues/343750849
            if (isOpenedWithAnchor)
                infoWindow.set('anchor', null);
            infoWindow.close();
        };
    }, [infoWindow, anchor, map, shouldFocus, infoWindowOptions, pixelOffset]);
    /* eslint-disable react-hooks/refs -- intentional access to refs during render to avoid cascading renders when creating portals */
    return (React__default.createElement(React__default.Fragment, null,
        contentContainerRef.current &&
            createPortal(children, contentContainerRef.current),
        headerContainerRef.current !== null &&
            createPortal(headerContent, headerContainerRef.current)));
    /* eslint-enable react-hooks/refs */
};

/**
 * Extracts paths as a nested array from a Polygon instance.
 */
function getPathsArray(polygon) {
    const mvcPaths = polygon.getPaths();
    const result = [];
    for (let i = 0; i < mvcPaths.getLength(); i++) {
        result.push(mvcPaths.getAt(i).getArray());
    }
    return result;
}
function usePolygon(props) {
    var _a, _b, _c;
    const { onClick, onDrag, onDragStart, onDragEnd, onMouseOver, onMouseOut, onPathsChanged, polygon: externalPolygon, encodedPaths, paths, defaultPaths } = props, destructuredOptions = __rest(props, ["onClick", "onDrag", "onDragStart", "onDragEnd", "onMouseOver", "onMouseOut", "onPathsChanged", "polygon", "encodedPaths", "paths", "defaultPaths"]);
    const [polygon, setPolygon] = useState(null);
    const map = useMap();
    const geometryLibrary = useMapsLibrary('geometry');
    // Track if we're programmatically updating to avoid firing onPathsChanged
    const isUpdatingRef = useRef(false);
    // Memoize options with automatic inference of clickable/draggable/editable
    const polygonOptions = useMemoized(Object.assign(Object.assign({}, destructuredOptions), { clickable: (_a = destructuredOptions.clickable) !== null && _a !== void 0 ? _a : Boolean(onClick), draggable: (_b = destructuredOptions.draggable) !== null && _b !== void 0 ? _b : Boolean(onDrag || onDragStart || onDragEnd || onPathsChanged), editable: (_c = destructuredOptions.editable) !== null && _c !== void 0 ? _c : Boolean(onPathsChanged) }), deepEqual);
    useEffect(() => {
        if (!map) {
            if (map === undefined)
                console.error('<Polygon> has to be inside a Map component.');
            return;
        }
        // Use provided instance or create a new one
        let instance;
        if (externalPolygon) {
            instance = externalPolygon;
            // Apply initial paths and options to the existing instance
            const initialPaths = paths !== null && paths !== void 0 ? paths : defaultPaths;
            if (initialPaths && Array.isArray(initialPaths)) {
                instance.setPaths(initialPaths);
            }
            instance.setOptions(polygonOptions);
        }
        else {
            const initialPaths = paths !== null && paths !== void 0 ? paths : defaultPaths;
            const polygonOptionsWithPaths = Object.assign({}, polygonOptions);
            // Google Maps throws "not an Array" error if paths is undefined
            if (initialPaths && Array.isArray(initialPaths)) {
                polygonOptionsWithPaths.paths = initialPaths;
            }
            instance = new google.maps.Polygon(polygonOptionsWithPaths);
        }
        // the options above are applied by now, so record them without writing
        setMapObjectOptions(instance, polygonOptions, { alreadyApplied: true });
        instance.setMap(map);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setPolygon(instance);
        return () => {
            instance.setMap(null);
            setPolygon(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- options are handled separately to avoid recreating the instance
    }, [map, externalPolygon]);
    useMapsEventListener(polygon, 'click', onClick);
    useMapsEventListener(polygon, 'drag', onDrag);
    useMapsEventListener(polygon, 'dragstart', onDragStart);
    useMapsEventListener(polygon, 'mouseover', onMouseOver);
    useMapsEventListener(polygon, 'mouseout', onMouseOut);
    // Fire onPathsChanged on dragend (when whole polygon is dragged)
    useMapsEventListener(polygon, 'dragend', (e) => {
        onDragEnd === null || onDragEnd === void 0 ? void 0 : onDragEnd(e);
        if (onPathsChanged && polygon && !isUpdatingRef.current) {
            onPathsChanged(getPathsArray(polygon));
        }
    });
    // Subscribe to MVCArray events for vertex-level edits
    useEffect(() => {
        if (!polygon || !onPathsChanged)
            return;
        const listeners = [];
        const mvcPaths = polygon.getPaths();
        if (typeof mvcPaths.getLength !==
            'function' ||
            typeof mvcPaths.getAt !== 'function') {
            return;
        }
        const handlePathsChange = () => {
            if (!isUpdatingRef.current) {
                onPathsChanged(getPathsArray(polygon));
            }
        };
        // Subscribe to each inner path's events
        const subscribeToInnerPath = (innerPath) => {
            listeners.push(google.maps.event.addListener(innerPath, 'insert_at', handlePathsChange));
            listeners.push(google.maps.event.addListener(innerPath, 'remove_at', handlePathsChange));
            listeners.push(google.maps.event.addListener(innerPath, 'set_at', handlePathsChange));
        };
        // Subscribe to existing inner paths
        for (let i = 0; i < mvcPaths.getLength(); i++) {
            subscribeToInnerPath(mvcPaths.getAt(i));
        }
        // Subscribe to outer array changes (paths added/removed)
        listeners.push(google.maps.event.addListener(mvcPaths, 'insert_at', (index) => {
            subscribeToInnerPath(mvcPaths.getAt(index));
            handlePathsChange();
        }));
        listeners.push(google.maps.event.addListener(mvcPaths, 'set_at', (index) => {
            subscribeToInnerPath(mvcPaths.getAt(index));
            handlePathsChange();
        }));
        listeners.push(google.maps.event.addListener(mvcPaths, 'remove_at', handlePathsChange));
        return () => {
            listeners.forEach(listener => listener.remove());
        };
    }, [
        polygon,
        onPathsChanged,
        paths,
        encodedPaths,
        polygonOptions.editable,
        polygonOptions.draggable
    ]);
    useEffect(() => {
        if (!polygon)
            return;
        setMapObjectOptions(polygon, polygonOptions);
    }, [polygon, polygonOptions]);
    // Sync controlled paths prop with the polygon instance
    useEffect(() => {
        if (!polygon || !paths)
            return;
        if (!Array.isArray(paths))
            return;
        // Normalize to nested array for comparison
        const firstPath = paths[0];
        const normalizedPaths = Array.isArray(firstPath) ? paths : [paths];
        const currentPaths = polygon.getPaths();
        if (!pathsEquals(normalizedPaths, currentPaths)) {
            isUpdatingRef.current = true;
            polygon.setPaths(paths);
            isUpdatingRef.current = false;
        }
    }, [polygon, paths]);
    // Handle encoded paths
    useEffect(() => {
        if (!polygon || !encodedPaths || !geometryLibrary)
            return;
        isUpdatingRef.current = true;
        const decodedPaths = encodedPaths.map(encodedPath => geometryLibrary.encoding.decodePath(encodedPath));
        polygon.setPaths(decodedPaths);
        isUpdatingRef.current = false;
    }, [polygon, encodedPaths, geometryLibrary]);
    return polygon;
}
const Polygon = forwardRef((props, ref) => {
    const polygon = usePolygon(props);
    useImperativeHandle(ref, () => polygon, [polygon]);
    return React__default.createElement(React__default.Fragment, null);
});
Polygon.displayName = 'Polygon';

function usePolyline(props) {
    var _a, _b, _c;
    const { onClick, onDrag, onDragStart, onDragEnd, onMouseOver, onMouseOut, onPathChanged, polyline: externalPolyline, encodedPath, path, defaultPath } = props, destructuredOptions = __rest(props, ["onClick", "onDrag", "onDragStart", "onDragEnd", "onMouseOver", "onMouseOut", "onPathChanged", "polyline", "encodedPath", "path", "defaultPath"]);
    const [polyline, setPolyline] = useState(null);
    const map = useMap();
    const geometryLibrary = useMapsLibrary('geometry');
    // Track if we're programmatically updating to avoid firing onPathChanged
    const isUpdatingRef = useRef(false);
    // Memoize options with automatic inference of clickable/draggable/editable
    const polylineOptions = useMemoized(Object.assign(Object.assign({}, destructuredOptions), { clickable: (_a = destructuredOptions.clickable) !== null && _a !== void 0 ? _a : Boolean(onClick), draggable: (_b = destructuredOptions.draggable) !== null && _b !== void 0 ? _b : Boolean(onDrag || onDragStart || onDragEnd || onPathChanged), editable: (_c = destructuredOptions.editable) !== null && _c !== void 0 ? _c : Boolean(onPathChanged) }), deepEqual);
    useEffect(() => {
        if (!map) {
            if (map === undefined)
                console.error('<Polyline> has to be inside a Map component.');
            return;
        }
        // Use provided instance or create a new one
        let instance;
        if (externalPolyline) {
            instance = externalPolyline;
            // Apply initial path and options to the existing instance
            const initialPath = path !== null && path !== void 0 ? path : defaultPath;
            if (initialPath && Array.isArray(initialPath)) {
                instance.setPath(initialPath);
            }
            instance.setOptions(polylineOptions);
        }
        else {
            const initialPath = path !== null && path !== void 0 ? path : defaultPath;
            const polylineOptionsWithPath = Object.assign({}, polylineOptions);
            // Google Maps throws "not an Array" error if path is undefined
            if (initialPath && Array.isArray(initialPath)) {
                polylineOptionsWithPath.path = initialPath;
            }
            instance = new google.maps.Polyline(polylineOptionsWithPath);
        }
        // the options above are applied by now, so record them without writing
        setMapObjectOptions(instance, polylineOptions, { alreadyApplied: true });
        instance.setMap(map);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setPolyline(instance);
        return () => {
            instance.setMap(null);
            setPolyline(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- options are handled separately to avoid recreating the instance
    }, [map, externalPolyline]);
    useMapsEventListener(polyline, 'click', onClick);
    useMapsEventListener(polyline, 'drag', onDrag);
    useMapsEventListener(polyline, 'dragstart', onDragStart);
    useMapsEventListener(polyline, 'mouseover', onMouseOver);
    useMapsEventListener(polyline, 'mouseout', onMouseOut);
    // Fire onPathChanged on dragend (when whole polyline is dragged)
    useMapsEventListener(polyline, 'dragend', (e) => {
        onDragEnd === null || onDragEnd === void 0 ? void 0 : onDragEnd(e);
        if (onPathChanged && polyline && !isUpdatingRef.current) {
            onPathChanged(polyline.getPath().getArray());
        }
    });
    // Subscribe to MVCArray events for vertex-level edits
    useEffect(() => {
        if (!polyline || !onPathChanged)
            return;
        const mvcPath = polyline.getPath();
        if (!mvcPath)
            return;
        const handlePathChange = () => {
            if (!isUpdatingRef.current) {
                onPathChanged(mvcPath.getArray());
            }
        };
        const listeners = [
            google.maps.event.addListener(mvcPath, 'insert_at', handlePathChange),
            google.maps.event.addListener(mvcPath, 'remove_at', handlePathChange),
            google.maps.event.addListener(mvcPath, 'set_at', handlePathChange)
        ];
        return () => {
            listeners.forEach(listener => listener.remove());
        };
    }, [
        polyline,
        onPathChanged,
        path,
        encodedPath,
        polylineOptions.editable,
        polylineOptions.draggable
    ]);
    useEffect(() => {
        if (!polyline)
            return;
        setMapObjectOptions(polyline, polylineOptions);
    }, [polyline, polylineOptions]);
    // Sync controlled path prop with the polyline instance
    useEffect(() => {
        if (!polyline || !path)
            return;
        const currentPath = polyline.getPath();
        if (!pathEquals(path, currentPath)) {
            isUpdatingRef.current = true;
            polyline.setPath(path);
            isUpdatingRef.current = false;
        }
    }, [polyline, path]);
    // Handle encoded path
    useEffect(() => {
        if (!polyline || !encodedPath || !geometryLibrary)
            return;
        isUpdatingRef.current = true;
        const decodedPath = geometryLibrary.encoding.decodePath(encodedPath);
        polyline.setPath(decodedPath);
        isUpdatingRef.current = false;
    }, [polyline, encodedPath, geometryLibrary]);
    return polyline;
}
const Polyline = forwardRef((props, ref) => {
    const polyline = usePolyline(props);
    useImperativeHandle(ref, () => polyline, [polyline]);
    return React__default.createElement(React__default.Fragment, null);
});
Polyline.displayName = 'Polyline';

/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const GestureHandling = GestureHandling$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const GoogleMaps3DContext = GoogleMaps3DContext$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const Map3D = Map3D$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const MapMode = MapMode$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const Marker3D = Marker3D$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const Marker3DContext = Marker3DContext$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const useMarker3D = useMarker3D$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const Popover = Popover$1;
/**
 * @deprecated Import from `@vis.gl/react-google-maps/3d` instead.
 */
const useMap3D = useMap3D$1;

/**
 * Copy of the `google.maps.ControlPosition` constants.
 * They have to be duplicated here since we can't wait for the maps API to load to be able to use them.
 */
const ControlPosition = {
    TOP_LEFT: 1,
    TOP_CENTER: 2,
    TOP: 2,
    TOP_RIGHT: 3,
    LEFT_CENTER: 4,
    LEFT_TOP: 5,
    LEFT: 5,
    LEFT_BOTTOM: 6,
    RIGHT_TOP: 7,
    RIGHT: 7,
    RIGHT_CENTER: 8,
    RIGHT_BOTTOM: 9,
    BOTTOM_LEFT: 10,
    BOTTOM_CENTER: 11,
    BOTTOM: 11,
    BOTTOM_RIGHT: 12,
    CENTER: 13,
    BLOCK_START_INLINE_START: 14,
    BLOCK_START_INLINE_CENTER: 15,
    BLOCK_START_INLINE_END: 16,
    INLINE_START_BLOCK_CENTER: 17,
    INLINE_START_BLOCK_START: 18,
    INLINE_START_BLOCK_END: 19,
    INLINE_END_BLOCK_START: 20,
    INLINE_END_BLOCK_CENTER: 21,
    INLINE_END_BLOCK_END: 22,
    BLOCK_END_INLINE_START: 23,
    BLOCK_END_INLINE_CENTER: 24,
    BLOCK_END_INLINE_END: 25
};
const MapControl = ({ children, position, className, style }) => {
    const controlContainer = useMemo(() => document.createElement('div'), []);
    const map = useMap();
    // ---- update className and styles for `controlContainer`
    // prevStyleRef stores previously applied style properties, so they can be
    // removed when unset
    const prevStyleRef = useRef(null);
    // eslint-disable-next-line react-hooks/immutability -- the control container DOM node is intentionally mutated from effects
    useLayoutEffect(() => {
        setValueForStyles(controlContainer, style || null, prevStyleRef.current);
        prevStyleRef.current = style || null;
        // eslint-disable-next-line react-hooks/immutability -- see above
        controlContainer.className = className !== null && className !== void 0 ? className : '';
    }, [controlContainer, className, style]);
    useEffect(() => {
        if (!map)
            return;
        const controls = map.controls[position];
        controls.push(controlContainer);
        return () => {
            const controlsArray = controls.getArray();
            // controlsArray could be undefined if the map is in an undefined state (e.g. invalid API-key, see #276
            if (!controlsArray)
                return;
            const index = controlsArray.indexOf(controlContainer);
            controls.removeAt(index);
        };
    }, [controlContainer, map, position]);
    return createPortal(children, controlContainer);
};

function useMarker(props) {
    const [marker, setMarker] = useState(null);
    const map = useMap();
    const { onClick, onDrag, onDragStart, onDragEnd, onMouseOver, onMouseOut } = props, markerOptions = __rest(props, ["onClick", "onDrag", "onDragStart", "onDragEnd", "onMouseOver", "onMouseOut"]);
    const { position, draggable } = markerOptions;
    // create marker instance and add to the map once the map is available
    useEffect(() => {
        if (!map) {
            if (map === undefined)
                console.error('<Marker> has to be inside a Map component.');
            return;
        }
        const newMarker = new google.maps.Marker(markerOptions);
        newMarker.setMap(map);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setMarker(newMarker);
        return () => {
            newMarker.setMap(null);
            setMarker(null);
        };
        // We do not want to re-render the whole marker when the options change.
        // Marker options update is handled in a useEffect below.
        // Excluding markerOptions from dependency array on purpose here.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map]);
    // attach and re-attach event-handlers when any of the properties change
    useEffect(() => {
        if (!marker)
            return;
        const m = marker;
        // Add event listeners
        const gme = google.maps.event;
        if (onClick)
            gme.addListener(m, 'click', onClick);
        if (onDrag)
            gme.addListener(m, 'drag', onDrag);
        if (onDragStart)
            gme.addListener(m, 'dragstart', onDragStart);
        if (onDragEnd)
            gme.addListener(m, 'dragend', onDragEnd);
        if (onMouseOver)
            gme.addListener(m, 'mouseover', onMouseOver);
        if (onMouseOut)
            gme.addListener(m, 'mouseout', onMouseOut);
        marker.setDraggable(Boolean(draggable));
        return () => {
            gme.clearInstanceListeners(m);
        };
    }, [
        marker,
        draggable,
        onClick,
        onDrag,
        onDragStart,
        onDragEnd,
        onMouseOver,
        onMouseOut
    ]);
    // update markerOptions (note the dependencies aren't properly checked
    // here, we just assume that setOptions is smart enough to not waste a
    // lot of time updating values that didn't change)
    useEffect(() => {
        if (!marker)
            return;
        if (markerOptions)
            marker.setOptions(markerOptions);
    }, [marker, markerOptions]);
    // update position when changed
    useEffect(() => {
        // Should not update position when draggable
        if (draggable || !position || !marker)
            return;
        marker.setPosition(position);
    }, [draggable, position, marker]);
    return marker;
}
/**
 * Component to render a marker on a map
 */
const Marker = forwardRef((props, ref) => {
    const marker = useMarker(props);
    useImperativeHandle(ref, () => marker, [marker]);
    return React__default.createElement(React__default.Fragment, null);
});
Marker.displayName = 'Marker';
function useMarkerRef() {
    const [marker, setMarker] = useState(null);
    const refCallback = useCallback((m) => {
        setMarker(m);
    }, []);
    return [refCallback, marker];
}

/**
 * Legacy implementation of Pin component for Maps API < 3.62
 * Component to configure the appearance of an AdvancedMarker or Marker3D
 */
const PinLegacy = props => {
    const advancedMarkerContext = useContext(AdvancedMarkerContext);
    const marker3dContext = useContext(Marker3DContext$1);
    const advancedMarker = advancedMarkerContext === null || advancedMarkerContext === void 0 ? void 0 : advancedMarkerContext.marker;
    const marker3d = marker3dContext === null || marker3dContext === void 0 ? void 0 : marker3dContext.marker;
    const setContentHandledExternally = marker3dContext === null || marker3dContext === void 0 ? void 0 : marker3dContext.setContentHandledExternally;
    const glyphContainer = useMemo(() => document.createElement('div'), []);
    // Load marker library for Marker3D case (AdvancedMarker already has it loaded)
    const markerLibrary = useMapsLibrary('marker');
    // Signal to Marker3D that we're handling content
    useEffect(() => {
        if (marker3d && setContentHandledExternally) {
            setContentHandledExternally(true);
            return () => setContentHandledExternally(false);
        }
    }, [marker3d, setContentHandledExternally]);
    // Handle Marker3D case - append PinElement directly
    useEffect(() => {
        if (!marker3d || !markerLibrary)
            return;
        const pinViewOptions = Object.assign({}, props);
        const pinElement = new markerLibrary.PinElement(pinViewOptions);
        // Set glyph to glyph container if children are present
        if (props.children) {
            pinElement.glyph = glyphContainer;
        }
        // Append PinElement directly to Marker3D (not in a template)
        // PinElement is a special element that Marker3D can handle natively
        while (marker3d.firstChild) {
            marker3d.removeChild(marker3d.firstChild);
        }
        marker3d.append(pinElement);
        return () => {
            // Cleanup handled by marker3d removal
        };
    }, [marker3d, markerLibrary, glyphContainer, props]);
    // Create Pin View instance for AdvancedMarker
    useEffect(() => {
        var _a;
        // Skip if we're in Marker3D context
        if (marker3d)
            return;
        if (!advancedMarker) {
            if (advancedMarker === undefined && marker3d === undefined) {
                console.error('The <Pin> component can only be used inside <AdvancedMarker> or <Marker3D>.');
            }
            return;
        }
        if (props.glyph && props.children) {
            logErrorOnce('The <Pin> component only uses children to render the glyph if both the glyph property and children are present.');
        }
        if (Children.count(props.children) > 1) {
            logErrorOnce('Passing multiple children to the <Pin> component might lead to unexpected results.');
        }
        const pinViewOptions = Object.assign({}, props);
        const pinElement = new google.maps.marker.PinElement(pinViewOptions);
        // Set glyph to glyph container if children are present (rendered via portal).
        // If both props.glyph and props.children are present, props.children takes priority.
        if (props.children) {
            pinElement.glyph = glyphContainer;
        }
        // Set content of Advanced Marker View to the Pin View element
        // Here we are selecting the anchor container.
        // The hierarchy is as follows:
        // "advancedMarker.content" (from google) -> "anchor container"
        const markerContent = (_a = advancedMarker.content) === null || _a === void 0 ? void 0 : _a.firstChild;
        while (markerContent === null || markerContent === void 0 ? void 0 : markerContent.firstChild) {
            markerContent.removeChild(markerContent.firstChild);
        }
        if (markerContent) {
            markerContent.appendChild(pinElement.element);
        }
    }, [advancedMarker, glyphContainer, marker3d, props]);
    return createPortal(props.children, glyphContainer);
};

/**
 * Modern implementation of Pin component for Maps API >= 3.62
 * Uses the new custom element API with glyphSrc/glyphText properties
 * Component to configure the appearance of an AdvancedMarker or Marker3D
 */
const PinModern = props => {
    const { children } = props;
    const advancedMarkerContext = useContext(AdvancedMarkerContext);
    const marker3dContext = useContext(Marker3DContext$1);
    const advancedMarker = advancedMarkerContext === null || advancedMarkerContext === void 0 ? void 0 : advancedMarkerContext.marker;
    const marker3d = marker3dContext === null || marker3dContext === void 0 ? void 0 : marker3dContext.marker;
    const setContentHandledExternally = marker3dContext === null || marker3dContext === void 0 ? void 0 : marker3dContext.setContentHandledExternally;
    const glyphContainer = useMemo(() => document.createElement('div'), []);
    const markerLibrary = useMapsLibrary('marker');
    // Signal to Marker3D that we're handling content
    useEffect(() => {
        if (marker3d && setContentHandledExternally) {
            setContentHandledExternally(true);
            return () => setContentHandledExternally(false);
        }
    }, [marker3d, setContentHandledExternally]);
    // Handle Marker3D case
    useEffect(() => {
        if (!marker3d || !markerLibrary)
            return;
        const pinOptions = Object.assign({}, props);
        const pinElement = new markerLibrary.PinElement(pinOptions);
        // Children still rendered via portal into a container
        if (children) {
            // In modern API, DOM children of PinElement serve as glyph
            pinElement.appendChild(glyphContainer);
        }
        // Append PinElement directly (not .element - that's deprecated)
        while (marker3d.firstChild) {
            marker3d.removeChild(marker3d.firstChild);
        }
        marker3d.appendChild(pinElement);
        return () => {
            // Cleanup handled by marker3d removal
        };
    }, [marker3d, markerLibrary, glyphContainer, children, props]);
    // Handle AdvancedMarker case
    useEffect(() => {
        var _a;
        if (marker3d)
            return; // Skip if in Marker3D context
        if (!advancedMarker || !markerLibrary) {
            if (advancedMarker === undefined && marker3d === undefined) {
                console.error('The <Pin> component can only be used inside <AdvancedMarker> or <Marker3D>.');
            }
            return;
        }
        if ((props.glyphSrc || props.glyphText) && children) {
            logErrorOnce('The <Pin> component only uses children to render the glyph if both glyphSrc/glyphText and children are present.');
        }
        if (Children.count(children) > 1) {
            logErrorOnce('Passing multiple children to the <Pin> component might lead to unexpected results.');
        }
        const pinOptions = Object.assign({}, props);
        const pinElement = new markerLibrary.PinElement(pinOptions);
        // Children rendered via portal into container
        if (children) {
            pinElement.appendChild(glyphContainer);
        }
        const markerContent = (_a = advancedMarker.content) === null || _a === void 0 ? void 0 : _a.firstChild;
        while (markerContent === null || markerContent === void 0 ? void 0 : markerContent.firstChild) {
            markerContent.removeChild(markerContent.firstChild);
        }
        if (markerContent) {
            // In modern API, append PinElement directly (not .element)
            markerContent.appendChild(pinElement);
        }
    }, [
        advancedMarker,
        markerLibrary,
        glyphContainer,
        marker3d,
        children,
        props
    ]);
    return createPortal(children, glyphContainer);
};

/**
 * Component to configure the appearance of an AdvancedMarker or Marker3D.
 *
 * Automatically detects the Maps API version and uses the appropriate implementation:
 * - Legacy implementation (< 3.62): Uses the original PinElement API with glyph property
 * - Modern implementation (≥ 3.62): Uses the new custom element API with glyphSrc/glyphText
 *
 * @example
 * ```tsx
 * // Basic usage
 * <AdvancedMarker position={{lat: 0, lng: 0}}>
 *   <Pin background="#FF0000" glyphColor="#FFFFFF" />
 * </AdvancedMarker>
 *
 * // With custom glyph (legacy)
 * <Pin glyph="📍" />
 *
 * // With custom glyph (modern, recommended for Maps API 3.62+)
 * <Pin glyphText="📍" />
 * <Pin glyphSrc="https://example.com/icon.png" />
 *
 * // With React children as glyph
 * <Pin>
 *   <CustomIcon />
 * </Pin>
 * ```
 */
const Pin = props => {
    var _a;
    const markerLibrary = useMapsLibrary('marker');
    // Detect capability after the marker library is loaded
    const isModern = useMemo(() => {
        if (!markerLibrary)
            return false;
        // Check if <gmp-pin> custom element exists
        // This happens while loading the marker library in Maps API 3.62+
        return (typeof customElements !== 'undefined' &&
            customElements.get('gmp-pin') !== undefined);
    }, [markerLibrary]);
    // Wait for marker library to load before rendering
    if (!markerLibrary)
        return null;
    // Map props based on which implementation we're using
    if (isModern) {
        // Modern: map old glyph prop to new glyphSrc/glyphText
        const { glyph, glyphSrc, glyphText } = props, restProps = __rest(props, ["glyph", "glyphSrc", "glyphText"]);
        const isUrl = glyph instanceof URL ||
            (typeof glyph === 'string' && glyph.startsWith('http'));
        const finalGlyphText = glyphText !== null && glyphText !== void 0 ? glyphText : (typeof glyph === 'string' && !isUrl ? glyph : undefined);
        const finalGlyphSrc = glyphSrc !== null && glyphSrc !== void 0 ? glyphSrc : (isUrl ? String(glyph) : undefined);
        return (React__default.createElement(PinModern, Object.assign({}, restProps, { glyphText: finalGlyphText, glyphSrc: finalGlyphSrc })));
    }
    else {
        // Legacy: map new glyphSrc/glyphText to old glyph prop
        const { glyph, glyphSrc, glyphText } = props, restProps = __rest(props, ["glyph", "glyphSrc", "glyphText"]);
        const finalGlyph = (_a = glyph !== null && glyph !== void 0 ? glyph : glyphSrc) !== null && _a !== void 0 ? _a : glyphText;
        return React__default.createElement(PinLegacy, Object.assign({}, restProps, { glyph: finalGlyph }));
    }
};

function useRectangle(props) {
    var _a, _b, _c;
    const { onClick, onDrag, onDragStart, onDragEnd, onMouseOver, onMouseOut, onBoundsChanged, bounds, defaultBounds } = props, destructuredOptions = __rest(props, ["onClick", "onDrag", "onDragStart", "onDragEnd", "onMouseOver", "onMouseOut", "onBoundsChanged", "bounds", "defaultBounds"]);
    const [rectangle, setRectangle] = useState(null);
    const map = useMap();
    // Memoize options with automatic inference of clickable/draggable/editable
    const rectangleOptions = useMemoized(Object.assign(Object.assign({}, destructuredOptions), { clickable: (_a = destructuredOptions.clickable) !== null && _a !== void 0 ? _a : Boolean(onClick), draggable: (_b = destructuredOptions.draggable) !== null && _b !== void 0 ? _b : Boolean(onDrag || onDragStart || onDragEnd || onBoundsChanged), editable: (_c = destructuredOptions.editable) !== null && _c !== void 0 ? _c : Boolean(onBoundsChanged) }), deepEqual);
    useEffect(() => {
        if (!map) {
            if (map === undefined)
                console.error('<Rectangle> has to be inside a Map component.');
            return;
        }
        const newRectangle = new google.maps.Rectangle(Object.assign(Object.assign({}, rectangleOptions), { bounds: bounds !== null && bounds !== void 0 ? bounds : defaultBounds }));
        // the options above are applied by now, so record them without writing
        setMapObjectOptions(newRectangle, rectangleOptions, { alreadyApplied: true });
        newRectangle.setMap(map);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional to sync the imperative instance with state
        setRectangle(newRectangle);
        return () => {
            newRectangle.setMap(null);
            setRectangle(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- rectangle options are handled separately to avoid recreating the instance
    }, [map]);
    useMapsEventListener(rectangle, 'click', onClick);
    useMapsEventListener(rectangle, 'drag', onDrag);
    useMapsEventListener(rectangle, 'dragstart', onDragStart);
    useMapsEventListener(rectangle, 'dragend', onDragEnd);
    useMapsEventListener(rectangle, 'mouseover', onMouseOver);
    useMapsEventListener(rectangle, 'mouseout', onMouseOut);
    useMapsEventListener(rectangle, 'bounds_changed', onBoundsChanged
        ? () => {
            onBoundsChanged(rectangle === null || rectangle === void 0 ? void 0 : rectangle.getBounds());
        }
        : null);
    useEffect(() => {
        if (!rectangle)
            return;
        setMapObjectOptions(rectangle, rectangleOptions);
    }, [rectangle, rectangleOptions]);
    // Sync controlled bounds prop with the rectangle instance
    useEffect(() => {
        if (!rectangle || !bounds)
            return;
        if (!boundsEquals(bounds, rectangle.getBounds())) {
            rectangle.setBounds(bounds);
        }
    }, [rectangle, bounds]);
    return rectangle;
}
const Rectangle = forwardRef((props, ref) => {
    const rectangle = useRectangle(props);
    useImperativeHandle(ref, () => rectangle, [
        rectangle
    ]);
    return React__default.createElement(React__default.Fragment, null);
});
Rectangle.displayName = 'Rectangle';

const mapLinear = (x, a1, a2, b1, b2) => b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
const getMapMaxTilt = (zoom) => {
    if (zoom <= 10) {
        return 30;
    }
    if (zoom >= 15.5) {
        return 67.5;
    }
    // range [10...14]
    if (zoom <= 14) {
        return mapLinear(zoom, 10, 14, 30, 45);
    }
    // range [14...15.5]
    return mapLinear(zoom, 14, 15.5, 45, 67.5);
};
/**
 * Function to limit the tilt range of the Google map when updating the view state
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const limitTiltRange = ({ viewState }) => {
    const pitch = viewState.pitch;
    const gmZoom = viewState.zoom + 1;
    const maxTilt = getMapMaxTilt(gmZoom);
    return Object.assign(Object.assign({}, viewState), { fovy: 25, pitch: Math.min(maxTilt, pitch) });
};

export { APILoadingStatus, APIProviderContext, AdvancedMarker, AdvancedMarkerAnchorPoint, AdvancedMarkerContext, AltitudeMode, Circle, CollisionBehavior, ColorScheme, ControlPosition, GestureHandling, GoogleMaps3DContext, GoogleMapsContext, InfoWindow, Map, Map3D, MapControl, MapMode, Marker, Marker3D, Marker3DContext, Pin, Polygon, Polyline, Popover, Rectangle, RenderingType, boundsEquals, isAdvancedMarker, isLatLngLiteral, latLngEquals, limitTiltRange, pathEquals, pathsEquals, toLatLngBoundsLiteral, toLatLngLiteral, useAdvancedMarkerRef, useApiIsLoaded, useApiLoadingStatus, useMap, useMap3D, useMapsLibrary, useMarker3D, useMarkerRef };
//# sourceMappingURL=index.modern.mjs.map
