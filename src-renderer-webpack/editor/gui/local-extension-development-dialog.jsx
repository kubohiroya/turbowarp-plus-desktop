import React from 'react';
import Modal from 'scratch-gui/src/components/modal/modal.jsx';
import {parseExtensionMetadata} from '@kubohiroya/turbowarp-extension-security-dialog';
import {ExtensionRow} from '@kubohiroya/turbowarp-extension-security-dialog/react';
import reviewStyles from '@kubohiroya/turbowarp-extension-security-dialog/project-review.css';
import styles from './desktop-settings-menu.css';

const messages = locale => locale.startsWith('ja') ? {
  title: '拡張ブロックの開発フォルダ',
  intro: 'チェックしたフォルダの完成ビルドを、この作品に自動で反映します。チェックを外すと、最後に読み込んだ版で動作を続けます。',
  folder: '開発フォルダ', add: '開発フォルダを追加…', remove: '一覧から外す', close: '閉じる',
  empty: '開発フォルダが登録されていません。'
} : {
  title: 'Extension Development Folders',
  intro: 'Checked folders update this project automatically after a completed build. Uncheck a folder to keep running its last loaded build.',
  folder: 'Development folder', add: 'Add Development Folder…', remove: 'Remove from list', close: 'Close',
  empty: 'No development folders are registered.'
};

function DevelopmentRow ({session, locale, text, errorText, onToggle, onRemove}) {
  const {name, description, descriptions, author, license, version} = parseExtensionMetadata(session.sourceHeader);
  return <ExtensionRow
    metadata={{name, description, descriptions, author, license, version}}
    ids={[session.id]}
    locale={locale}
    previewCache={null}
    pick={{checked: session.enabled, disabled: session.busy, onToggle: () => onToggle(session.token, !session.enabled)}}
    details={<div className={styles.developmentPath}>
      <strong>{text.folder}</strong>
      <code>{session.directory}</code>
    </div>}
  >
    {session.error && <p className="twextsec-failed" role="alert">{errorText(session.error)}</p>}
    <div className="twextsec-actions">
      <button type="button" onClick={() => onRemove(session.token)} disabled={session.busy}>{text.remove}</button>
    </div>
  </ExtensionRow>;
}

export function LocalExtensionDevelopmentDialog ({locale, sessions, error, errorText, adding, onClose, onAdd, onToggle, onRemove}) {
  const text = messages(locale);
  return <Modal contentLabel={text.title} className={reviewStyles.frame} onRequestClose={onClose}>
    <div className={`${reviewStyles.body} ${styles.developmentBody}`}>
      <div className={`twextsec-review ${styles.developmentReview}`}>
        <div className={styles.developmentRows}>
          <p className="twextsec-intro">{text.intro}</p>
          {error && <p className="twextsec-failed" role="alert">{error}</p>}
          {sessions.length === 0 ? <p>{text.empty}</p> : <ul className="twextsec-rows">
            {sessions.map(session => <DevelopmentRow key={session.token} {...{session, locale, text, errorText, onToggle, onRemove}} />)}
          </ul>}
        </div>
        <div className={`twextsec-actions ${styles.developmentActions}`}>
          <button type="button" onClick={onAdd} disabled={adding}>{text.add}</button>
          <button type="button" onClick={onClose} disabled={adding}>{text.close}</button>
        </div>
      </div>
    </div>
  </Modal>;
}
