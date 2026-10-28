import React__default, { useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { u as usePropBinding, a as useDomEventListener } from '../chunks/use-map-3d-BOXDWF5P.mjs';
export { G as GestureHandling, b as GoogleMaps3DContext, M as Map3D, c as MapMode, d as Marker3D, e as Marker3DContext, P as Popover, f as useMap3D, g as useMarker3D } from '../chunks/use-map-3d-BOXDWF5P.mjs';
import 'react-dom';

function useCustomElementRef(ref) {
    const [element, setElement] = useState(null);
    const elementRef = useCallback((node) => {
        setElement(node);
    }, []);
    useImperativeHandle(ref, () => element, [element]);
    return [element, elementRef];
}

/**
 * CirclePath component for displaying circle paths on a 3D map.
 */
const CirclePath = forwardRef(function CirclePath(props, ref) {
    const { center, radius } = props;
    const [circlePath, circlePathRef] = useCustomElementRef(ref);
    usePropBinding(circlePath, 'center', center);
    usePropBinding(circlePath, 'radius', radius);
    return (React__default.createElement("gmp-circle-path", { ref: circlePathRef, center: center, radius: radius }));
});
CirclePath.displayName = 'CirclePath';

/**
 * Flattener component for flattening a specified area on a 3D map.
 */
const Flattener = forwardRef(function Flattener(props, ref) {
    const { innerPaths, path } = props;
    const [flattener, flattenerRef] = useCustomElementRef(ref);
    usePropBinding(flattener, 'innerPaths', innerPaths);
    usePropBinding(flattener, 'path', path);
    return (React__default.createElement("gmp-flattener", { ref: flattenerRef, innerPaths: innerPaths, path: path }));
});
Flattener.displayName = 'Flattener';

/**
 * Marker component for displaying custom HTML markers on a 3D map.
 *
 * Automatically uses MarkerInteractiveElement when onClick is provided,
 * otherwise uses MarkerElement.
 */
const Marker = forwardRef(function Marker(props, ref) {
    const { children, onClick, altitudeMode, anchorLeft, anchorTop, autofitsCamera, collisionBehavior, collisionPriority, gmpPopoverTargetElement, position, title } = props;
    const [marker, markerRef] = useCustomElementRef(ref);
    const isInteractive = Boolean(onClick);
    useDomEventListener(marker, 'gmp-click', onClick);
    usePropBinding(marker, 'altitudeMode', altitudeMode);
    usePropBinding(marker, 'anchorLeft', anchorLeft);
    usePropBinding(marker, 'anchorTop', anchorTop);
    usePropBinding(marker, 'autofitsCamera', autofitsCamera);
    usePropBinding(marker, 'collisionBehavior', collisionBehavior);
    usePropBinding(marker, 'collisionPriority', collisionPriority);
    usePropBinding(marker, 'position', position);
    usePropBinding(marker, 'title', title);
    usePropBinding(marker, 'gmpPopoverTargetElement', gmpPopoverTargetElement);
    return isInteractive ? (React__default.createElement("gmp-marker-interactive", { ref: markerRef }, children)) : (React__default.createElement("gmp-marker", { ref: markerRef }, children));
});
Marker.displayName = 'Marker';

/**
 * Model3D component for rendering glTF models on a 3D map.
 *
 * Automatically uses Model3DInteractiveElement when onClick is provided,
 * otherwise uses Model3DElement.
 */
const Model3D = forwardRef(function Model3D(props, ref) {
    const { onClick, altitudeMode, orientation, position, scale, src } = props;
    const [model, modelRef] = useCustomElementRef(ref);
    const isInteractive = Boolean(onClick);
    useDomEventListener(model, 'gmp-click', onClick);
    usePropBinding(model, 'altitudeMode', altitudeMode);
    usePropBinding(model, 'orientation', orientation);
    usePropBinding(model, 'position', position);
    usePropBinding(model, 'scale', scale);
    usePropBinding(model, 'src', src);
    return isInteractive ? (React__default.createElement("gmp-model-3d-interactive", { ref: modelRef })) : (React__default.createElement("gmp-model-3d", { ref: modelRef }));
});
Model3D.displayName = 'Model3D';

/**
 * Polygon3D component for displaying filled polygons on a 3D map.
 *
 * Automatically uses Polygon3DInteractiveElement when onClick is provided,
 * otherwise uses Polygon3DElement.
 */
const Polygon3D = forwardRef(function Polygon3D(props, ref) {
    const { onClick, altitudeMode, autofitsCamera, drawsOccludedSegments, extruded, fillColor, geodesic, innerCoordinates, innerPaths, outerCoordinates, path, strokeColor, strokeWidth, zIndex } = props;
    const [polygon, polygonRef] = useCustomElementRef(ref);
    const isInteractive = Boolean(onClick);
    useDomEventListener(polygon, 'gmp-click', onClick);
    usePropBinding(polygon, 'altitudeMode', altitudeMode);
    usePropBinding(polygon, 'autofitsCamera', autofitsCamera);
    usePropBinding(polygon, 'drawsOccludedSegments', drawsOccludedSegments);
    usePropBinding(polygon, 'extruded', extruded);
    usePropBinding(polygon, 'fillColor', fillColor);
    usePropBinding(polygon, 'geodesic', geodesic);
    usePropBinding(polygon, 'innerCoordinates', innerCoordinates);
    usePropBinding(polygon, 'innerPaths', innerPaths);
    usePropBinding(polygon, 'outerCoordinates', outerCoordinates);
    usePropBinding(polygon, 'path', path);
    usePropBinding(polygon, 'strokeColor', strokeColor);
    usePropBinding(polygon, 'strokeWidth', strokeWidth);
    usePropBinding(polygon, 'zIndex', zIndex);
    return isInteractive ? (React__default.createElement("gmp-polygon-3d-interactive", { ref: polygonRef })) : (React__default.createElement("gmp-polygon-3d", { ref: polygonRef }));
});
Polygon3D.displayName = 'Polygon3D';

/**
 * Polyline3D component for displaying connected line segments on a 3D map.
 *
 * Automatically uses Polyline3DInteractiveElement when onClick is provided,
 * otherwise uses Polyline3DElement.
 */
const Polyline3D = forwardRef(function Polyline3D(props, ref) {
    const { onClick, altitudeMode, autofitsCamera, coordinates, drawsOccludedSegments, extruded, geodesic, outerColor, outerWidth, path, strokeColor, strokeWidth, zIndex } = props;
    const [polyline, polylineRef] = useCustomElementRef(ref);
    const isInteractive = Boolean(onClick);
    useDomEventListener(polyline, 'gmp-click', onClick);
    usePropBinding(polyline, 'altitudeMode', altitudeMode);
    usePropBinding(polyline, 'autofitsCamera', autofitsCamera);
    usePropBinding(polyline, 'coordinates', coordinates);
    usePropBinding(polyline, 'drawsOccludedSegments', drawsOccludedSegments);
    usePropBinding(polyline, 'extruded', extruded);
    usePropBinding(polyline, 'geodesic', geodesic);
    usePropBinding(polyline, 'outerColor', outerColor);
    usePropBinding(polyline, 'outerWidth', outerWidth);
    usePropBinding(polyline, 'path', path);
    usePropBinding(polyline, 'strokeColor', strokeColor);
    usePropBinding(polyline, 'strokeWidth', strokeWidth);
    usePropBinding(polyline, 'zIndex', zIndex);
    return isInteractive ? (React__default.createElement("gmp-polyline-3d-interactive", { ref: polylineRef })) : (React__default.createElement("gmp-polyline-3d", { ref: polylineRef }));
});
Polyline3D.displayName = 'Polyline3D';

export { CirclePath, Flattener, Marker, Model3D, Polygon3D, Polyline3D };
//# sourceMappingURL=index.modern.mjs.map
