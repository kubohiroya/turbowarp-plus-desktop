import getStageControls from '@tw-plus/pinned-stage-controls';
import AddonHooks from 'scratch-gui/src/addons/hooks.js';
import addonRedux from 'scratch-gui/src/addons/redux.js';
import {editorAddonPanelHost} from './local-editor-addon-panels.js';

const paintSet = 'scratch-paint/clipboard/SET';
const paintIncrement = 'scratch-paint/clipboard/INCREMENT_PASTE_OFFSET';
const paintClear = 'scratch-paint/clipboard/CLEAR_PASTE_OFFSET';

const validLabel = value => typeof value === 'string' && value.length <= 80 && value.trim();
const validText = value => typeof value === 'string' && value.length <= 800;
const validEntry = entry => typeof entry?.id === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(entry.id) &&
  validLabel(entry.label);
const validList = (entries, count, valid = validEntry) => Array.isArray(entries) && entries.length <= count &&
  entries.every(valid) && new Set(entries.map(entry => entry.id)).size === entries.length;
const validPanel = panel => validEntry(panel) && validText(panel.text) &&
  validList(panel.actions, 6) && panel.actions.length > 0;

const moveWorkspace = operation => {
  const workspace = AddonHooks.blocklyWorkspace;
  if (!workspace?.getInjectionDiv?.()?.getClientRects().length) return;
  switch (operation) {
  case 'fit': workspace.zoomToFit(); break;
  case 'center': workspace.scrollCenter(); break;
  case 'zoom-in': workspace.zoomCenter(1); break;
  case 'zoom-out': workspace.zoomCenter(-1); break;
  }
};

let connection;

export function startEditorAddonRuntime (vm, host) {
  if (!host) return;
  if (connection?.vm === vm) return connection.ready;
  connection?.dispose();
  const {api} = getStageControls(vm);
  const panelHost = editorAddonPanelHost(vm);
  const staged = new Map();
  const active = new Map();
  let paintOffsetOverridden = false;
  const cancelInvocation = build => {
    clearTimeout(build.invocation?.timeout);
    build.invocation = null;
  };
  const disposeBuild = (build, restorePaint) => {
    if (!build) return;
    build.stopPaint?.();
    if (restorePaint && build.stopPaint && paintOffsetOverridden &&
        !Array.from(active.values()).some(other => other !== build && other.stopPaint)) {
      paintOffsetOverridden = false;
      if (addonRedux.state.scratchPaint?.clipboard?.pasteOffset === 0) addonRedux.dispatch({type: paintIncrement});
    }
    clearTimeout(build.timeout);
    cancelInvocation(build);
    for (const button of build.buttons) button.dispose();
    build.port.close();
    build.frame.remove();
  };
  const remove = (builds, key, restorePaint = false) => {
    disposeBuild(builds.get(key), restorePaint);
    builds.delete(key);
  };
  const reset = () => {
    panelHost.show(null);
    for (const key of staged.keys()) remove(staged, key);
    for (const key of active.keys()) remove(active, key);
  };
  const prepare = ({runtimeId, token, format, id, defaults, sources, startup, paintClipboard, viewport}) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Editor add-on runtime';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = new URL('editor-addon-runtime.html', document.baseURI).href;
    const {port1, port2} = new MessageChannel();
    const build = {frame, port: port1, commands: null, buttons: [], invocation: null, paintEvents: false};
    staged.set(runtimeId, build);

    const prepared = success => {
      if (staged.get(runtimeId) !== build) return;
      clearTimeout(build.timeout);
      if (!success) remove(staged, runtimeId);
      void host.prepared(runtimeId, success).catch(() => remove(staged, runtimeId));
    };
    build.timeout = setTimeout(() => prepared(false), 4000);
    port1.onmessage = ({data}) => {
      if (data?.type === 'ready' && staged.get(runtimeId) === build && !build.commands) {
        build.paintEvents = paintClipboard && data.paintEvents === true;
        const accepted = validList(data.commands, 12) && validList(data.panels, 4, validPanel) &&
          Boolean(data.commands.length || data.panels.length || build.paintEvents);
        if (accepted) Object.assign(build, {commands: data.commands, panels: data.panels});
        prepared(accepted);
      } else if (data?.type === 'failed' && !build.commands) {
        prepared(false);
      } else if (data?.type === 'paint-result' && active.get(token) === build &&
          build.paintRequest && data.request === build.paintRequest) {
        build.paintRequest = null;
        if (data.clearOffset === true) {
          paintOffsetOverridden = true;
          addonRedux.dispatch({type: paintClear});
        }
      } else if (data?.type === 'result' && active.get(token) === build &&
          build.invocation && build.invocation.request === data.request) {
        const {button, panel} = build.invocation;
        cancelInvocation(build);
        if (panel) {
          const view = panelHost.read();
          if (view?.build !== build || view.id !== panel) return;
          if (validText(data.text)) panelHost.show({...view, text: data.text});
        } else if (validLabel(data.label)) {
          button.update({label: data.label});
        }
        if (viewport && typeof data.workspace === 'string') moveWorkspace(data.workspace);
        if (data.project === 'run') vm.greenFlag();
        if (data.project === 'stop') vm.stopAll();
      }
    };
    frame.addEventListener('load', () => {
      frame.contentWindow.postMessage(
        {type: 'local-editor-addon-connect', format, id, defaults, sources, startup, paintClipboard}, '*', [port2]);
    }, {once: true});
    document.body.appendChild(frame);
  };

  const invoke = (token, build, id, {button, panel}) => {
    if (build.invocation || active.get(token) !== build) return;
    const request = crypto.randomUUID();
    const timeout = setTimeout(() => { build.invocation = null; }, 3000);
    build.invocation = {request, button, panel, timeout};
    build.port.postMessage({id, panel, request});
  };
  const closePanel = () => {
    const view = panelHost.read();
    if (!view) return;
    if (view.build.invocation?.panel === view.id) cancelInvocation(view.build);
    panelHost.show(null);
  };
  const showPanel = (token, build, descriptor) => {
    if (active.get(token) !== build) return;
    const previous = panelHost.read();
    if (previous && previous.build.invocation?.panel === previous.id) cancelInvocation(previous.build);
    panelHost.show({...descriptor, token, build, close: closePanel,
      run: id => invoke(token, build, id, {panel: descriptor.id})});
  };
  const register = (token, build) => {
    for (const button of build.buttons) button.dispose();
    const createButton = (kind, id, label, onClick) => {
      const button = api.addButton({id: `local-editor-addon-${token}-${kind}-${id}`, label, onClick});
      button.update({visible: true});
      return button;
    };
    build.buttons = [
      ...build.commands.map(({id, label}) => {
        const button = createButton('command', id, label, () => invoke(token, build, id, {button}));
        return button;
      }),
      ...build.panels.map(panel => createButton('panel', panel.id, panel.label, () => showPanel(token, build, panel)))
    ];
  };
  const attachPaintEvents = build => {
    const stateChanged = ({detail}) => {
      const action = detail.action.type;
      if (action !== paintSet && action !== paintIncrement) return;
      build.paintRequest = crypto.randomUUID();
      build.port.postMessage({type: 'paint', action, request: build.paintRequest});
    };
    addonRedux.addEventListener('statechanged', stateChanged);
    build.stopPaint = () => addonRedux.removeEventListener('statechanged', stateChanged);
  };
  const projectLoaded = () => {
    closePanel();
    for (const [token, build] of active) {
      cancelInvocation(build);
      register(token, build);
    }
  };
  // The Workbench clears project-scoped controls on PROJECT_LOADED. These add-ons belong to the editor window.
  vm.on('PROJECT_LOADED', projectLoaded);
  const unsubscribe = host.onRuntime(message => {
    switch (message.type) {
    case 'prepare': prepare(message); break;
    case 'accept': {
      const build = staged.get(message.runtimeId);
      if (!build?.commands) break;
      staged.delete(message.runtimeId);
      const currentPanel = panelHost.read();
      remove(active, message.token, !build.paintEvents);
      active.set(message.token, build);
      if (build.paintEvents) attachPaintEvents(build);
      register(message.token, build);
      if (currentPanel?.token === message.token) {
        const nextPanel = build.panels.find(panel => panel.id === currentPanel.id);
        if (nextPanel) showPanel(message.token, build, nextPanel);
        else closePanel();
      }
      break;
    }
    case 'discard': remove(staged, message.runtimeId); break;
    case 'remove':
      if (panelHost.read()?.token === message.token) closePanel();
      remove(active, message.token, true);
      break;
    case 'reset': reset(); break;
    }
  });
  const ready = host.ready().catch(() => {});
  connection = {vm, ready, dispose: () => {
    unsubscribe();
    vm.removeListener('PROJECT_LOADED', projectLoaded);
    reset();
  }};
  return ready;
}
