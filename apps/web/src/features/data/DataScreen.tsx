/**
 * Data & Backups screen (route /data).
 *
 * Everything on this screen is local: files are written by the platform save
 * helper and read by the platform file picker. There are no network calls.
 */
import { navigate } from '../../router';
import { Card, Icon } from '../../ui/components';
import { ExportSection } from './ExportSection';
import { ImportSection } from './ImportSection';
import './data.css';

export function DataScreen() {
  return (
    <main className="screen">
      <button type="button" className="btn btn-plain data-back" onClick={() => navigate('/settings')}>
        <Icon name="chevron-left" size={18} /> Settings
      </button>

      <div className="screen-head">
        <div>
          <h1 className="screen-title">Data &amp; Backups</h1>
          <div className="sub">Export, import and restore your data. Everything stays on this device.</div>
        </div>
      </div>

      <div className="data-sections">
        <ExportSection />
        <ImportSection />

        <section className="data-section" aria-labelledby="data-integrity-heading">
          <h2 className="data-section-label" id="data-integrity-heading">
            Backup integrity &amp; recovery
          </h2>
          <Card className="card-pad data-card">
            <ul className="data-list">
              <li>
                <strong>Pre-import snapshot.</strong> Before a replace import, deUrge asks the storage layer to keep a snapshot
                of the current local database. That snapshot is a safety net for the storage layer — it is not a backup file you
                can export from this build, so export a JSON or encrypted backup if the current data matters to you.
              </li>
              <li>
                <strong>Replacing is irreversible.</strong> A replace import removes the data currently on this device and writes
                the file's contents. Only do it when you have a backup of the current state.
              </li>
              <li>
                <strong>Plain files vs encrypted backups.</strong> JSON and CSV files are readable by anyone who opens them.
                Encrypted backups are protected with your password (PBKDF2-SHA256 + AES-GCM). There is no password recovery:
                keep the password somewhere safe.
              </li>
              <li>
                <strong>How to restore.</strong> Choose a backup file in Import, review the preview, then merge or replace.
                Nothing is written until you confirm, and every conflict is reported after the import.
              </li>
              <li>
                <strong>Offline by design.</strong> No export or import ever contacts a server or sends your data anywhere.
              </li>
            </ul>
          </Card>
        </section>
      </div>
    </main>
  );
}
