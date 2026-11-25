import React from 'react';
import {IconMenuButton} from '@kubohiroya/turbowarp-plus-editor-windows';
import {renderStageControls as renderEditorStageControls} from '@tw-plus/pinned-gui-host';
import {DesktopSettingsMenuContext} from './desktop-settings-menu-context.js';
import {LocalEditorAddonDevelopmentDialog} from './local-editor-addon-development-dialog.jsx';
import {LocalExtensionDevelopmentDialog} from './local-extension-development-dialog.jsx';
import styles from './desktop-settings-menu.css';

export * from '@tw-plus/pinned-gui-host';

// Desktop has its own menu and keeps the same menu-bar layout as the legacy About button.
export const ProjectInfoMenu = undefined;

function DesktopSettingsMenu () {
  const menu = React.useContext(DesktopSettingsMenuContext);
  const [open, setOpen] = React.useState(null);
  const [adding, setAdding] = React.useState(false);
  if (!menu) return null;

  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      await menu.development.onAdd();
    } finally {
      setAdding(false);
    }
  };
  const items = [
    {id: 'extension-development-folders', label: menu.foldersLabel, onSelect: () => setOpen('extension')},
    ...(EditorPreload.localEditorAddons ? [{id: 'editor-addon-development-folders',
      label: menu.development.locale.startsWith('ja') ? 'エディタアドオンの開発フォルダ…' : 'Editor Add-on Development Folders…',
      onSelect: () => setOpen('addon')}] : [])
  ];
  return <>
    <IconMenuButton label={menu.label} items={items} icon="⚙️" className={styles.settingsMenu} />
    {open === 'extension' && <LocalExtensionDevelopmentDialog {...menu.development} adding={adding} onAdd={add}
      onClose={() => { if (!adding) setOpen(null); }} />}
    {open === 'addon' && <LocalEditorAddonDevelopmentDialog locale={menu.development.locale}
      host={EditorPreload.localEditorAddons} onClose={() => setOpen(null)} />}
  </>;
}

export const renderStageControls = props => <>
  {renderEditorStageControls(props)}
  {props.menuLocale !== undefined && <DesktopSettingsMenu />}
</>;
