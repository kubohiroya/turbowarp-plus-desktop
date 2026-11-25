const panelHosts = new WeakMap();

export function editorAddonPanelHost (vm) {
  if (!panelHosts.has(vm)) {
    let panel = null;
    const listeners = new Set();
    panelHosts.set(vm, {
      read: () => panel,
      show: value => {
        panel = value;
        listeners.forEach(listener => listener(panel));
      },
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    });
  }
  return panelHosts.get(vm);
}
