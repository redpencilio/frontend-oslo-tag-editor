import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { service } from '@ember/service';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { not } from 'ember-truth-helpers';
import { isOsloTag } from 'oslo-tag-editor/oslo-tags';

const PAGE_SIZE = 100;

// Normalise each raw row from a source to a unified shape consumed by the template.
// `table` and `idColumn` drive upsertTag; null = read-only row.
function mkObjectRow(r) {
  return {
    ...r,
    source:      'object',
    table:       't_objectproperties',
    idColumn:    'Object_ID',
    elementId:   r.objectId,
    displayName: r.elementName ?? '—',
    subName:     null,
    packageId:   r.packageId,
    packageName: r.packageName,
    elementType: r.elementType,
  };
}

function mkAttributeRow(r) {
  return {
    ...r,
    source:      'attribute',
    table:       't_attributetag',
    idColumn:    'ElementID',
    elementId:   r.elementId,
    displayName: r.attributeName ?? '—',
    subName:     r.elementName,   // shown below the attribute name
    packageId:   r.packageId,
    packageName: r.packageName,
    elementType: r.elementType,
  };
}

function mkConnectorRow(r) {
  return {
    ...r,
    source:      'connector',
    table:       't_connectortag',
    idColumn:    'ElementID',
    elementId:   r.connectorId,
    displayName: r.connectorName || `${r.sourceName} → ${r.destName}`,
    subName:     `${r.sourceName ?? '?'} → ${r.destName ?? '?'}`,
    packageId:   r.packageId,
    packageName: null,
    elementType: r.connectorType,
  };
}

function mkRoleRow(r) {
  return {
    ...r,
    source:      'role',
    table:       null,   // TODO: editing t_taggedvalue role tags not yet implemented
    idColumn:    null,
    elementId:   null,
    displayName: `${r.sourceName ?? '?'} → ${r.destName ?? '?'}`,
    subName:     r.role === 'ASSOCIATION_SOURCE' ? 'source end' : 'target end',
    packageId:   r.packageId,
    packageName: null,
    elementType: r.connectorType,
  };
}

const SOURCE_LABEL = {
  object:    'Obj',
  attribute: 'Attr',
  connector: 'Conn',
  role:      'Role',
};

export default class TagEditor extends Component {
  @service eaDatabase;

  @tracked filterTag     = '';
  @tracked filterElement = '';
  @tracked filterValue   = '';
  @tracked osloOnly      = true;
  @tracked page          = 0;

  // { table, idColumn, elementId, tagName } | null
  @tracked editingRow = null;
  @tracked editDraft  = '';

  // ── data ──────────────────────────────────────────────────────────────────

  get allRows() {
    if (!this.eaDatabase.isLoaded) return [];

    return [
      ...this.eaDatabase.getAllObjectTags().map(mkObjectRow),
      ...this.eaDatabase.getAllAttributeTags().map(mkAttributeRow),
      ...this.eaDatabase.getAllConnectorTags().map(mkConnectorRow),
      ...this.eaDatabase.getAllConnectorRoleTags().map(mkRoleRow),
    ];
  }

  get filteredRows() {
    let rows = this.allRows;

    if (this.args.packageId != null) {
      rows = rows.filter((r) => r.packageId === this.args.packageId);
    }
    if (this.osloOnly) {
      rows = rows.filter((r) => isOsloTag(r.tagName));
    }
    if (this.filterTag) {
      const q = this.filterTag.toLowerCase();
      rows = rows.filter((r) => (r.tagName ?? '').toLowerCase().includes(q));
    }
    if (this.filterElement) {
      const q = this.filterElement.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.displayName ?? '').toLowerCase().includes(q) ||
          (r.subName     ?? '').toLowerCase().includes(q) ||
          (r.elementType ?? '').toLowerCase().includes(q),
      );
    }
    if (this.filterValue) {
      const q = this.filterValue.toLowerCase();
      rows = rows.filter((r) => this.effectiveValue(r).toLowerCase().includes(q));
    }

    return rows;
  }

  get pageCount()      { return Math.max(1, Math.ceil(this.filteredRows.length / PAGE_SIZE)); }
  get pagedRows()      { const s = this.page * PAGE_SIZE; return this.filteredRows.slice(s, s + PAGE_SIZE); }
  get isFirstPage()    { return this.page === 0; }
  get isLastPage()     { return this.page >= this.pageCount - 1; }
  get hasPagination()  { return this.pageCount > 1; }
  get hasEdits()       { return this.eaDatabase.editCount > 0; }
  get currentPageLabel() { return `Page ${this.page + 1} of ${this.pageCount}`; }

  // ── per-row helpers — arrow functions so `this` is bound in template ──────

  effectiveValue = (row) => {
    if (!row.table) return row.tagValue ?? '';
    const edit = this.eaDatabase.getPendingEdit(row.table, row.elementId, row.tagName);
    return edit?.value ?? row.tagValue ?? '';
  };

  isEditing = (row) => {
    const e = this.editingRow;
    return e && e.table === row.table && e.elementId === row.elementId && e.tagName === row.tagName;
  };

  isEdited = (row) => {
    if (!row.table) return false;
    return !!this.eaDatabase.getPendingEdit(row.table, row.elementId, row.tagName);
  };

  sourceLabel = (row) => SOURCE_LABEL[row.source] ?? row.source;

  // ── filter actions ────────────────────────────────────────────────────────

  @action onFilterTag(e)     { this.filterTag     = e.target.value; this.page = 0; }
  @action onFilterElement(e) { this.filterElement = e.target.value; this.page = 0; }
  @action onFilterValue(e)   { this.filterValue   = e.target.value; this.page = 0; }
  @action toggleOsloOnly()   { this.osloOnly = !this.osloOnly;      this.page = 0; }
  @action prevPage()         { if (this.page > 0) this.page--; }
  @action nextPage()         { if (this.page < this.pageCount - 1) this.page++; }

  // ── edit actions ──────────────────────────────────────────────────────────

  @action
  startEdit(row) {
    if (!row.table) return; // role tags: TODO editing t_taggedvalue
    this.editingRow = { table: row.table, idColumn: row.idColumn, elementId: row.elementId, tagName: row.tagName };
    this.editDraft  = this.effectiveValue(row);
  }

  @action cancelEdit() { this.editingRow = null; this.editDraft = ''; }

  @action
  commitEdit() {
    if (!this.editingRow) return;
    const { table, idColumn, elementId, tagName } = this.editingRow;
    this.eaDatabase.upsertTag(table, idColumn, elementId, tagName, this.editDraft);
    this.editingRow = null;
    this.editDraft  = '';
  }

  @action onDraftChange(e) { this.editDraft = e.target.value; }

  @action
  onDraftKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.commitEdit(); }
    if (e.key === 'Escape') this.cancelEdit();
  }

  @action revertRow(row)  { this.eaDatabase.revertEdit(row.table, row.elementId, row.tagName); }
  @action revertAll()     { this.eaDatabase.revertAll(); }
  @action exportEdits()   { this.eaDatabase.save(); }

  <template>
    <div class="editor">

      <header class="editor__header">
        <div class="editor__meta">
          <span class="editor__filename">{{this.eaDatabase.fileName}}</span>
          <span class="chip">{{this.allRows.length}} tags</span>
          <span class="chip">{{this.filteredRows.length}} shown</span>
          {{#if this.hasEdits}}
            <span class="chip chip--warn">{{this.eaDatabase.editCount}} edits</span>
          {{/if}}
        </div>
        <div class="editor__actions"></div>
      </header>

      <div class="filter-bar">
        <label class="filter-field">
          <span class="filter-field__label">Tag name</span>
          <input class="input" type="search" placeholder="filter…" value={{this.filterTag}} oninput={{this.onFilterTag}} />
        </label>
        <label class="filter-field">
          <span class="filter-field__label">Element / Name</span>
          <input class="input" type="search" placeholder="filter…" value={{this.filterElement}} oninput={{this.onFilterElement}} />
        </label>
        <label class="filter-field">
          <span class="filter-field__label">Value</span>
          <input class="input" type="search" placeholder="filter…" value={{this.filterValue}} oninput={{this.onFilterValue}} />
        </label>
        <label class="filter-toggle">
          <input type="checkbox" checked={{this.osloOnly}} onchange={{this.toggleOsloOnly}} />
          OSLO tags only
        </label>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Element / Name</th>
              <th>Package</th>
              <th>Tag</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {{! TODO: add a row / form here to insert a new tag into any of the three tables }}
            {{#each this.pagedRows as |row|}}
              <tr class="{{if (this.isEdited row) 'row--edited'}}">

                <td class="cell-source">
                  <span class="source-badge source-badge--{{row.source}}">{{this.sourceLabel row}}</span>
                </td>

                <td class="mono cell-element">
                  {{row.displayName}}
                  {{#if row.subName}}
                    <span class="cell-subname">{{row.subName}}</span>
                  {{/if}}
                  {{#if row.elementType}}
                    <span class="badge">{{row.elementType}}</span>
                  {{/if}}
                </td>

                <td class="mono cell-muted">{{row.packageName}}</td>
                <td class="mono cell-tag">{{row.tagName}}</td>

                <td class="cell-editable">
                  {{#if (this.isEditing row)}}
                    <textarea
                      class="cell-input"
                      rows="2"
                      oninput={{this.onDraftChange}}
                      onkeydown={{this.onDraftKeydown}}
                      onblur={{this.commitEdit}}
                    >{{this.editDraft}}</textarea>
                  {{else}}
                    <span
                      class="mono cell-text {{if (not row.table) 'cell-text--readonly'}}"
                      role={{if row.table "button"}}
                      title={{if row.table "Click to edit" "Read-only (role tag editing coming soon)"}}
                      {{on "click" (fn this.startEdit row)}}
                    >{{this.effectiveValue row}}</span>
                  {{/if}}
                </td>

                <td class="cell-actions">
                  {{#if (this.isEdited row)}}
                    <button class="btn-icon" title="Revert" type="button"
                      {{on "click" (fn this.revertRow row)}}>↩</button>
                  {{/if}}
                </td>

              </tr>
            {{else}}
              <tr>
                <td colspan="6" class="cell-empty">No tagged values match the current filters.</td>
              </tr>
            {{/each}}
          </tbody>
        </table>
      </div>

      {{#if this.hasPagination}}
        <div class="pagination">
          <button class="btn btn--ghost" type="button" disabled={{this.isFirstPage}} {{on "click" this.prevPage}}>← Prev</button>
          <span class="pagination__label">{{this.currentPageLabel}}</span>
          <button class="btn btn--ghost" type="button" disabled={{this.isLastPage}} {{on "click" this.nextPage}}>Next →</button>
        </div>
      {{/if}}

    </div>
  </template>
}
