import type { CategoryKind, CustomCategory } from '../domain';
import { fail } from '../util/errors';
import { newId } from '../util/ids';
import { LIMITS, requireOneOf, requireText } from '../validation';
import { categoryRepo } from '../repos/categories';
import { appendHistory, write, type CoreContext } from './context';

const KINDS: CategoryKind[] = ['trigger', 'reason', 'tracker_category'];

export class CategoryService {
  constructor(private readonly ctx: CoreContext) {}

  list(kind?: CategoryKind, includeArchived = false): CustomCategory[] {
    const categories = categoryRepo.list(this.ctx.db, kind);
    return includeArchived ? categories : categories.filter((category) => !category.archived);
  }

  get(id: string): CustomCategory {
    const category = categoryRepo.get(this.ctx.db, id);
    if (!category) fail('NOT_FOUND', 'That category could not be found.');
    return category;
  }

  async create(kind: CategoryKind, name: string): Promise<CustomCategory> {
    const validatedKind = requireOneOf(kind, 'kind', 'Category type', KINDS);
    const validatedName = requireText(name, 'name', LIMITS.categoryName, 'Category name');
    if (categoryRepo.findByName(this.ctx.db, validatedKind, validatedName)) {
      fail('CONFLICT', 'A category with that name already exists.');
    }
    const now = this.ctx.clock.now();
    const category: CustomCategory = {
      id: newId(),
      kind: validatedKind,
      name: validatedName,
      sortOrder: 1000,
      isDefault: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    return write(this.ctx, () => {
      categoryRepo.insert(this.ctx.db, category);
      appendHistory(this.ctx, {
        trackerId: null,
        type: 'categories_updated',
        occurredAt: now,
        metadata: { action: 'created', kind: validatedKind, name: validatedName },
      });
      return category;
    });
  }

  async rename(id: string, name: string): Promise<CustomCategory> {
    const category = this.get(id);
    const validatedName = requireText(name, 'name', LIMITS.categoryName, 'Category name');
    const duplicate = categoryRepo.findByName(this.ctx.db, category.kind, validatedName);
    if (duplicate && duplicate.id !== id) fail('CONFLICT', 'A category with that name already exists.');
    const now = this.ctx.clock.now();
    const next: CustomCategory = { ...category, name: validatedName, updatedAt: now };
    return write(this.ctx, () => {
      categoryRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, {
        trackerId: null,
        type: 'categories_updated',
        occurredAt: now,
        metadata: { action: 'renamed', kind: category.kind, from: category.name, to: validatedName },
      });
      return next;
    });
  }

  async setArchived(id: string, archived: boolean): Promise<CustomCategory> {
    const category = this.get(id);
    const now = this.ctx.clock.now();
    const next: CustomCategory = { ...category, archived, updatedAt: now };
    return write(this.ctx, () => {
      categoryRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, {
        trackerId: null,
        type: 'categories_updated',
        occurredAt: now,
        metadata: { action: archived ? 'archived' : 'restored', kind: category.kind, name: category.name },
      });
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    const category = this.get(id);
    if (category.isDefault) {
      fail('CONFLICT', 'Built-in categories can be archived but not deleted, so your history stays readable.');
    }
    const now = this.ctx.clock.now();
    await write(this.ctx, () => {
      categoryRepo.delete(this.ctx.db, id);
      appendHistory(this.ctx, {
        trackerId: null,
        type: 'categories_updated',
        occurredAt: now,
        metadata: { action: 'deleted', kind: category.kind, name: category.name },
      });
    });
  }
}
