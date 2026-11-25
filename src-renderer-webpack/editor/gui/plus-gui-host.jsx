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
  if (!menu) return null;
  const items = [{id: 'development-folders', label: menu.manageLabel, onSelect: () => setOpen(true)}, ...menu.items];
  return <>
    <IconMenuButton label={menu.label} items={items} icon="⚙️" className={styles.settingsMenu} />
    {open && <LocalExtensionDevelopmentDialog {...menu.development} onClose={() => setOpen(false)} />}
  </>;
}

export const renderStageControls = props => <>
  {renderEditorStageControls(props)}
  {props.menuLocale !== undefined && <DesktopSettingsMenu />}
</>;
