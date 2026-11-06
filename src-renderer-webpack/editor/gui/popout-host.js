import {openBackpackWindow as openPinnedBackpackWindow} from '@tw-plus/pinned-backpack-window-host';
import {createBrowserHost} from '@tw-plus/browser-window-host';
export {detachBackpackOpener, getBackpackOpenLabel} from '@tw-plus/pinned-backpack-window-host';
export {createWebPanelHost} from '@tw-plus/pinned-desktop-panel-host';

export const openBackpackWindow = (url, ticket) => {
  if (!EditorPreload.reservePopout?.('backpack', ticket)) return null;
  return openPinnedBackpackWindow(url, ticket);
};

export function createDesktopPanelHost (kind, flag, width, height, synchronousPageHide = true) {
  if (typeof EditorPreload === 'undefined' || new URLSearchParams(location.search).get(flag) !== '1') return null;
  return createBrowserHost(window, (_url, ticket) => {
    if (!EditorPreload.reservePopout?.(kind, ticket)) return null;
    return window.open('about:blank', `tw-plus-${kind}-${ticket}`, `popup,width=${width},height=${height}`);
  }, `${kind}-popout.html`, true, synchronousPageHide);
}
