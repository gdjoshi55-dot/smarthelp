/**
 * @deprecated Use the new functional API: `setOptions()` and `importLibrary()`.
 * See the migration guide for more details: MIGRATION.md
 */
declare class Loader {
    constructor(...args: any[]);
}

type APIOptions = {
    key?: string;
    v?: string;
    language?: string;
    region?: string;
    libraries?: string[];
    authReferrerPolicy?: string;
    mapIds?: string[];
    channel?: string;
    solutionChannel?: string;
};
/** @deprecated use `google.maps.ImportLibraryMap` from `@types/google.maps` instead */
type LibraryMap = google.maps.ImportLibraryMap;
type LibraryName = keyof google.maps.ImportLibraryMap;
/**
 * Sets the options for the Maps JavaScript API.
 *
 * Has to be called before any library is loaded.
 *
 * See https://developers.google.com/maps/documentation/javascript/load-maps-js-api#required_parameters
 * for the full documentation of available options.
 *
 * @param options The options to set.
 */
declare function setOptions(options: APIOptions): void;
/**
 * Imports the specified library from the Maps JavaScript API.
 *
 * The first call to this function will start actually loading the Maps
 * JavaScript API.
 *
 * @param libraryName The name of the library to load.
 * @returns A promise that resolves with the loaded library. In case of an
 *   error (due to poor network conditions, browser extensions, etc.), the
 *   returned promise is rejected with an error.
 */
declare function importLibrary<TLibraryName extends LibraryName>(libraryName: TLibraryName): Promise<google.maps.ImportLibraryMap[TLibraryName]>;

export { Loader, importLibrary, setOptions };
export type { APIOptions, LibraryMap };
