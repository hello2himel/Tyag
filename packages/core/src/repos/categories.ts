import type { CategoryKind, CustomCategory } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { boolToInt, intToBool, requiredNumber, requiredString, type BoolInt } from './rows';

interface CategoryRow {
  id: string;
  kind: string;
  name: string;
  sort_order: number;
  is_default: BoolInt;
  archived: BoolInt;
  created_at: number;
  updated_at: number;
}

function mapCategory(row: CategoryRow): CustomCategory {
  return {
    id: requiredString(row.id, 'custom_categories.id'),
    kind: requiredString(row.kind, 'custom_categories.kind') as CategoryKind,
    name: requiredString(row.name, 'custom_categories.name'),
    sortOrder: requiredNumber(row.sort_order, 'custom_categories.sort_order'),
    isDefault: intToBool(row.is_default),
    archived: intToBool(row.archived),
    createdAt: requiredNumber(row.created_at, 'custom_categories.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'custom_categories.updated_at'),
  };
}

export const categoryRepo = {
  insert(db: SqlDatabase, category: CustomCategory): void {
    db.run(
      `INSERT INTO custom_categories (id, kind, name, sort_order, is_default, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category.id,
        category.kind,
        category.name,
        category.sortOrder,
        boolToInt(category.isDefault),
        boolToInt(category.archived),
        category.createdAt,
        category.updatedAt,
      ],
    );
  },
  update(db: SqlDatabase, category: CustomCategory): void {
    db.run(
      `UPDATE custom_categories SET name = ?, sort_order = ?, archived = ?, updated_at = ? WHERE id = ?`,
      [category.name, category.sortOrder, boolToInt(category.archived), category.updatedAt, category.id],
    );
  },
  get(db: SqlDatabase, id: string): CustomCategory | null {
    const row = db.get<CategoryRow>('SELECT * FROM custom_categories WHERE id = ?', [id]);
    return row ? mapCategory(row) : null;
  },
  list(db: SqlDatabase, kind?: CategoryKind): CustomCategory[] {
    const rows = kind
      ? db.all<CategoryRow>('SELECT * FROM custom_categories WHERE kind = ? ORDER BY sort_order ASC, name ASC', [kind])
      : db.all<CategoryRow>('SELECT * FROM custom_categories ORDER BY kind ASC, sort_order ASC, name ASC');
    return rows.map(mapCategory);
  },
  findByName(db: SqlDatabase, kind: CategoryKind, name: string): CustomCategory | null {
    const row = db.get<CategoryRow>('SELECT * FROM custom_categories WHERE kind = ? AND name = ? COLLATE NOCASE', [
      kind,
      name,
    ]);
    return row ? mapCategory(row) : null;
  },
  delete(db: SqlDatabase, id: string): void {
    // References keep working: events store both a category id (nullable) and
    // a plain text trigger, so deleting a category never removes history.
    db.run('UPDATE lapse_events SET trigger_category_id = NULL WHERE trigger_category_id = ?', [id]);
    db.run('UPDATE urge_events SET trigger_category_id = NULL WHERE trigger_category_id = ?', [id]);
    db.run('UPDATE trackers SET category_id = NULL WHERE category_id = ?', [id]);
    db.run('DELETE FROM custom_categories WHERE id = ?', [id]);
  },
};
