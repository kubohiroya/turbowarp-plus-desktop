import {openBackpackWindow as openPinnedBackpackWindow} from '@tw-plus/pinned-backpack-window-host';
export {detachBackpackOpener, getBackpackOpenLabel} from '@tw-plus/pinned-backpack-window-host';

export const openBackpackWindow = (url, ticket) => {
  if (!EditorPreload.reserveBackpackPopout?.(ticket)) return null;
  return openPinnedBackpackWindow(url, ticket);
};
