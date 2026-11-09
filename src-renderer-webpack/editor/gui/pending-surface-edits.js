/**
 * The standard renderer has no views in other windows, so there is nothing to collect before a save.
 * The Plus renderer replaces this module with the Editor's collector (scripts/plus-renderer.webpack.cjs).
 * @returns {Promise<void>}
 */
export const flushPendingSurfaceEdits = async () => {};
