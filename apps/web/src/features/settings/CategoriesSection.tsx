/**
 * Settings → Triggers & reasons.
 *
 * Manages the trigger and reason lists used when recording lapses and urges.
 * Counts are computed from the stored records so the user can see whether an
 * entry is actually used. Built-in entries can be archived but not deleted (the
 * core enforces this too); deleting a custom entry never rewrites history.
 */
import { useId, useMemo, useState } from 'react';
import { isDeUrgeError, userMessage, type CategoryKind, type CustomCategory } from '@deurge/core';
import { useApp } from '../../store/app';
import {
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  ListGroup,
  Modal,
  Segmented,
  useToast,
} from '../../ui/components';

const KIND_OPTIONS: { value: CategoryKind; label: string }[] = [
  { value: 'trigger', label: 'Triggers' },
  { value: 'reason', label: 'Reasons' },
];

const KIND_LABEL: Record<CategoryKind, string> = {
  trigger: 'Trigger',
  reason: 'Reason',
};

export function CategoriesSection() {
  const app = useApp();
  const toast = useToast();
  const idPrefix = useId();
  const addNameId = `${idPrefix}-add-name`;
  const renameNameId = `${idPrefix}-rename-name`;

  const [kind, setKind] = useState<CategoryKind>('trigger');
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [renameTarget, setRenameTarget] = useState<CustomCategory | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CustomCategory | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const categories = useMemo(() => {
    try {
      return app.core.categories.list(kind, true);
    } catch {
      return [] as CustomCategory[];
    }
  }, [app.core, app.version, kind]);

  /** Counts of records that reference each category, by id first then by text. */
  const countFor = useMemo(() => {
    const byId = new Map<string, number>();
    const byText = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    try {
      for (const lapse of app.core.lapses.list()) {
        if (lapse.triggerCategoryId) bump(byId, lapse.triggerCategoryId);
        else if (lapse.trigger) bump(byText, `trigger:${lapse.trigger.trim().toLowerCase()}`);
        if (lapse.reason) bump(byText, `reason:${lapse.reason.trim().toLowerCase()}`);
      }
      for (const urge of app.core.urges.list()) {
        if (urge.triggerCategoryId) bump(byId, urge.triggerCategoryId);
        else if (urge.trigger) bump(byText, `trigger:${urge.trigger.trim().toLowerCase()}`);
      }
    } catch {
      // Usage counts are informative only; the list still works without them.
    }
    return (category: CustomCategory): number => {
      const byIdCount = byId.get(category.id);
      if (byIdCount !== undefined) return byIdCount;
      const key =
        category.kind === 'trigger'
          ? `trigger:${category.name.trim().toLowerCase()}`
          : category.kind === 'reason'
            ? `reason:${category.name.trim().toLowerCase()}`
            : null;
      return key ? (byText.get(key) ?? 0) : 0;
    };
  }, [app.core, app.version]);

  const active = categories.filter((category) => !category.archived);
  const archived = categories.filter((category) => category.archived);
  const kindLabel = KIND_LABEL[kind];

  const run = async (key: string, action: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (busyKey !== null) return false;
    setBusyKey(key);
    try {
      await action();
      app.refresh();
      toast.show(success);
      return true;
    } catch (error) {
      toast.error(
        isDeUrgeError(error) ? userMessage(error) : 'That change could not be saved. Nothing else was changed.',
      );
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const create = async () => {
    const name = addName.trim();
    if (!name) return;
    const ok = await run('create', () => app.core.categories.create(kind, name), `${kindLabel} added.`);
    if (ok) {
      setAddOpen(false);
      setAddName('');
    }
  };

  const rename = async () => {
    const name = renameName.trim();
    if (!renameTarget || !name) return;
    const ok = await run('rename', () => app.core.categories.rename(renameTarget.id, name), `${KIND_LABEL[renameTarget.kind]} renamed.`);
    if (ok) {
      setRenameTarget(null);
      setRenameName('');
    }
  };

  const setArchived = async (category: CustomCategory, nextArchived: boolean) => {
    await run(
      `archive-${category.id}`,
      () => app.core.categories.setArchived(category.id, nextArchived),
      nextArchived ? `${KIND_LABEL[category.kind]} archived.` : `${KIND_LABEL[category.kind]} restored.`,
    );
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const ok = await run('delete', () => app.core.categories.delete(deleteTarget.id), `${KIND_LABEL[deleteTarget.kind]} deleted.`);
    if (ok) setDeleteTarget(null);
  };

  const renderRow = (category: CustomCategory) => {
    const count = countFor(category);
    return (
      <div className={`category-row ${category.archived ? 'archived' : ''}`} key={category.id}>
        <div className="category-main">
          <div className="category-name">{category.name}</div>
          <div className="category-meta">
            {count > 0 ? `Used by ${count} record${count === 1 ? '' : 's'}` : 'Not used yet'}
            <span aria-hidden="true"> · </span>
            {category.isDefault ? 'Built-in' : 'Custom'}
            {category.archived ? <span> · Archived</span> : null}
          </div>
        </div>
        <div className="category-actions">
          {category.archived ? (
            <IconButton
              label={`Restore ${category.name}`}
              icon="refresh"
              disabled={busyKey !== null}
              onClick={() => void setArchived(category, false)}
            />
          ) : (
            <IconButton
              label={`Archive ${category.name}`}
              icon="archive"
              disabled={busyKey !== null}
              onClick={() => void setArchived(category, true)}
            />
          )}
          <IconButton
            label={`Rename ${category.name}`}
            icon="edit"
            disabled={busyKey !== null}
            onClick={() => {
              setRenameTarget(category);
              setRenameName(category.name);
            }}
          />
          {category.isDefault ? null : (
            <IconButton
              label={`Delete ${category.name}`}
              icon="trash"
              disabled={busyKey !== null}
              onClick={() => setDeleteTarget(category)}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="stack">
      <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} ariaLabel="Trigger or reason list" />

      <ListGroup aria-label={`${kindLabel}s`}>
        {active.length === 0 ? (
          <div className="list-row">
            <span className="mut">No active {kindLabel.toLowerCase()}s.</span>
          </div>
        ) : (
          active.map(renderRow)
        )}
        <button
          type="button"
          className="list-row selectable category-add"
          onClick={() => {
            setAddName('');
            setAddOpen(true);
          }}
          disabled={busyKey !== null}
        >
          <span style={{ color: 'var(--b)' }}>+ Add {kindLabel.toLowerCase()}</span>
        </button>
      </ListGroup>

      {archived.length > 0 ? (
        showArchived ? (
          <>
            <Button variant="plain" onClick={() => setShowArchived(false)}>
              Hide archived ({archived.length})
            </Button>
            <ListGroup aria-label="Archived triggers and reasons">{archived.map(renderRow)}</ListGroup>
          </>
        ) : (
          <Button variant="plain" onClick={() => setShowArchived(true)}>
            Show archived ({archived.length})
          </Button>
        )
      ) : null}

      <p className="setting-note">
        Built-in triggers and reasons can be archived but not deleted, so old records stay readable. Archiving hides an
        entry from new records; existing records keep their text. Deleting a custom entry never rewrites history.
      </p>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={`New ${kindLabel.toLowerCase()}`}
        actions={
          <>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!addName.trim() || busyKey !== null} onClick={() => void create()}>
              Add
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor={addNameId} hint="Up to 60 characters.">
          <Input
            id={addNameId}
            value={addName}
            onChange={(event) => setAddName(event.target.value)}
            maxLength={60}
            autoFocus
            placeholder={`New ${kindLabel.toLowerCase()}`}
          />
        </Field>
      </Modal>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename"
        actions={
          <>
            <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button variant="primary" disabled={!renameName.trim() || busyKey !== null} onClick={() => void rename()}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor={renameNameId} hint="Existing records keep the text they were saved with.">
          <Input
            id={renameNameId}
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            maxLength={60}
            autoFocus
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete “${deleteTarget?.name ?? ''}”?`}
        body={
          <div>
            <p>
              This custom entry will be removed from the list. Records that reference it keep their text, but the link to
              it is lost.
            </p>
            <p style={{ marginTop: 8 }}>This cannot be undone.</p>
          </div>
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
