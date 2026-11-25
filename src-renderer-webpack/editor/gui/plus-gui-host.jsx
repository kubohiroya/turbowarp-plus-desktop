import React from 'react';
import {IconMenuButton} from '@kubohiroya/turbowarp-plus-editor-windows';
import {renderStageControls as renderEditorStageControls} from '@tw-plus/pinned-gui-host';
import {DesktopSettingsMenuContext} from './desktop-settings-menu-context.js';
import {LocalExtensionDevelopmentDialog} from './local-extension-development-dialog.jsx';
import styles from './desktop-settings-menu.css';

export * from '@tw-plus/pinned-gui-host';

// Desktop has its own menu and keeps the same menu-bar layout as the legacy About button.
export const ProjectInfoMenu = undefined;

function DesktopSettingsMenu () {
  const menu = React.useContext(DesktopSettingsMenuContext);
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  if (!menu) return null;

  const add = async () => {
    if (adding) return;
    setOpen(true);
    setAdding(true);
    try {
      await menu.development.onAdd();
    } finally {
      setAdding(false);
    }
  };
  const items = [
    {id: 'open-development-folder', label: menu.startLabel, onSelect: () => { void add(); }},
    {id: 'stop-extension-reload', label: menu.stopLabel, onSelect: () => setOpen(true)}
  ];
  return <>
    <IconMenuButton label={menu.label} items={items} icon="⚙️" className={styles.settingsMenu} />
    {open && <LocalExtensionDevelopmentDialog {...menu.development} adding={adding} onAdd={add}
      onClose={() => { if (!adding) setOpen(false); }} />}
  </>;
}

export const renderStageControls = props => <>
  {renderEditorStageControls(props)}
  {props.menuLocale !== undefined && <DesktopSettingsMenu />}
</>;
