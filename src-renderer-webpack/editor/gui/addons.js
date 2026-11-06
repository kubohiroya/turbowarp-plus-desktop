import SettingsStore from 'scratch-gui/src/addons/settings-store-singleton';
import AddonChannels from 'scratch-gui/src/addons/channels';
import runAddons from 'scratch-gui/src/addons/entry.js';
import manifests from 'scratch-gui/src/addons/generated/addon-manifests';
import upstreamMeta from 'scratch-gui/src/addons/generated/upstream-meta.json';

AddonChannels.reloadChannel.addEventListener('message', () => {
  location.reload();
});

AddonChannels.changeChannel.addEventListener('message', ({data}) => {
  if (data?.version !== upstreamMeta.commit || !data.store) return;
  // The store compares explicit flags to decide whether to toggle a running addon.
  for (const [id, current] of Object.entries(SettingsStore.store)) {
    const incoming = data.store[id];
    if (!incoming || typeof incoming !== 'object' || incoming.enabled === current.enabled) continue;
    const manifest = manifests[id];
    const defaultEnabled = !manifest.unsupported && !!manifest.enabledByDefault;
    current.enabled ??= defaultEnabled;
    incoming.enabled ??= defaultEnabled;
  }
  SettingsStore.setStoreWithVersionCheck(data);
});

runAddons();
