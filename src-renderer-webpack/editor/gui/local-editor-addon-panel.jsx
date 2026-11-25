import React from 'react';
import Modal from 'scratch-gui/src/components/modal/modal.jsx';
import reviewStyles from '@kubohiroya/turbowarp-extension-security-dialog/project-review.css';
import {editorAddonPanelHost} from './local-editor-addon-panels.js';
import styles from './desktop-settings-menu.css';

export function LocalEditorAddonPanel ({vm}) {
  const host = editorAddonPanelHost(vm);
  const [panel, setPanel] = React.useState(host.read);
  React.useEffect(() => {
    const unsubscribe = host.subscribe(setPanel);
    setPanel(host.read());
    return unsubscribe;
  }, [host]);
  if (!panel) return null;
  return <Modal contentLabel={panel.label} className={reviewStyles.frame} onRequestClose={panel.close}>
    <div className={reviewStyles.body}>
      <div className={styles.editorAddonPanel}>
        {panel.text && <p role="status">{panel.text}</p>}
        <div className="twextsec-actions">
          {panel.actions.map(action =>
            <button key={action.id} type="button" onClick={() => panel.run(action.id)}>{action.label}</button>)}
        </div>
      </div>
    </div>
  </Modal>;
}
