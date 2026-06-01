import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { gt } from 'ember-truth-helpers';
import { Languages, LanguageDependentTags, parseTagName } from 'oslo-tag-editor/oslo-tags';

const FIXED_LANGS  = ['nl', 'en'];
const EXTRA_LANGS  = Languages.filter((l) => !FIXED_LANGS.includes(l));

const LONG_BASES = new Set(['definition', 'usageNote', 'ap-definition', 'ap-usageNote']);

// Tags whose cells need a wider column (URLs, etc.)
const WIDE_TAGS = new Set(['uri', 'parentURI', 'ontologyURI', 'baseURI', 'ap-codelist', 'range', 'package']);

export default class TagGrid extends Component {
  @tracked extraActiveLangs = new Set();

  #drafts = new Map();
  #dirty  = new Set();
  @tracked dirtyVersion = 0;

  // ── computed ─────────────────────────────────────────────────────────────

  get activeLangs() {
    return new Set([...FIXED_LANGS, ...this.extraActiveLangs]);
  }

  /** Filter @tagColumns to those whose language is active, then group for header rendering. */
  get visibleColumns() {
    const active = this.activeLangs;
    return (this.args.tagColumns ?? []).filter((col) => {
      const { lang } = parseTagName(col);
      return lang === null || active.has(lang);
    });
  }

  /**
   * Group visible columns into header spans for the two-row header:
   *   Row 1: base-tag group labels (colspan = number of language variants)
   *   Row 2: individual lang suffixes (or the tag name for language-independent)
   *
   * Returns: Array<{ base, span, cols: [{tagName, lang}] }>
   */
  get columnGroups() {
    const groups = [];
    let current  = null;

    for (const tagName of this.visibleColumns) {
      const { base, lang } = parseTagName(tagName);

      if (lang !== null && LanguageDependentTags.includes(base)) {
        // Language-dependent: group by base
        if (current?.base === base) {
          current.cols.push({ tagName, lang });
          current.span++;
        } else {
          current = { base, span: 1, cols: [{ tagName, lang }] };
          groups.push(current);
        }
      } else {
        // Language-independent: each column is its own group
        current = { base: tagName, span: 1, cols: [{ tagName, lang: null }] };
        groups.push(current);
        current = null; // force new group next iteration
      }
    }

    return groups;
  }

  get extraLangs() { return EXTRA_LANGS; }
  get hasItems()   { return (this.args.items?.length ?? 0) > 0; }

  // ── per-cell helpers — arrow functions for correct `this` ────────────────

  isLongField  = (tagName) => LONG_BASES.has(parseTagName(tagName).base);
  isWideField  = (tagName) => WIDE_TAGS.has(tagName) || WIDE_TAGS.has(parseTagName(tagName).base);
  isLangActive = (lang)    => FIXED_LANGS.includes(lang) || this.extraActiveLangs.has(lang);
  getItemProp  = (item, key) => item?.[key] ?? '';

  cellValue = (item, tagName) => {
    this.dirtyVersion;
    const key = this.#key(item, tagName);
    return this.#drafts.has(key) ? this.#drafts.get(key) : this.#origValue(item, tagName);
  };

  isDirty = (item, tagName) => {
    this.dirtyVersion;
    return this.#dirty.has(this.#key(item, tagName));
  };

  colClass = (tagName) => {
    const parts = ['tg-col-tag'];
    if (this.isWideField(tagName)) parts.push('tg-col-tag--wide');
    return parts.join(' ');
  };

  // Validation severity for a cell: 'error' | 'warning' | 'info' | null
  // Reads from @cellSeverity Map<`${itemId}::${tagName}`, severity>
  cellValidation = (item, tagName) => {
    return this.args.cellSeverity?.get(`${item.id}::${tagName}`) ?? null;
  };

  cellClass = (item, tagName) => {
    const parts = ['tg-tag-cell'];
    if (this.isWideField(tagName)) parts.push('tg-tag-cell--wide');
    if (this.isDirty(item, tagName)) parts.push('cell--dirty');
    const sev = this.cellValidation(item, tagName);
    if (sev) parts.push(`cell--${sev}`);
    return parts.join(' ');
  };

  // ── language toggle ───────────────────────────────────────────────────────

  @action toggleLang(lang) {
    const next = new Set(this.extraActiveLangs);
    if (next.has(lang)) next.delete(lang); else next.add(lang);
    this.extraActiveLangs = next;
  }

  // ── cell events ───────────────────────────────────────────────────────────

  @action onCellInput(item, tagName, event) {
    this.#drafts.set(this.#key(item, tagName), event.target.value);
  }

  @action onCellBlur(item, tagName, event) {
    const key     = this.#key(item, tagName);
    const newVal  = event.target.value;
    const origVal = this.#origValue(item, tagName);

    this.#drafts.set(key, newVal);

    const nowDirty = newVal !== origVal;
    if (nowDirty) this.#dirty.add(key); else this.#dirty.delete(key);

    this.dirtyVersion++;

    if (nowDirty) this.args.onTagChanged?.(item.id, tagName, newVal);
  }

  @action onCellKeydown(item, tagName, event) {
    if (event.key === 'Escape') {
      const orig = this.#origValue(item, tagName);
      event.target.value = orig;
      this.#drafts.delete(this.#key(item, tagName));
      event.target.blur();
    }
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      event.target.blur();
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  #key(item, tagName) { return `${item.id}::${tagName}`; }

  #origValue(item, tagName) {
    return this.args.tags?.get(item.id)?.find((t) => t.tagName === tagName)?.tagValue ?? '';
  }

  // ── template ──────────────────────────────────────────────────────────────

  <template>
    <div class="tag-grid-wrap">

      {{! ── language toggle bar ─────────────────────────────────────────── }}
      <div class="tag-grid-langs">
        <span class="lang-label">Languages:</span>
        {{#each FIXED_LANGS as |lang|}}
          <span class="lang-badge lang-badge--fixed lang-badge--active">{{lang}}</span>
        {{/each}}
        {{#each this.extraLangs as |lang|}}
          <button type="button"
            class="lang-badge {{if (this.isLangActive lang) 'lang-badge--active'}}"
            {{on "click" (fn this.toggleLang lang)}}
          >{{lang}}</button>
        {{/each}}
      </div>

      {{! ── scrollable table ────────────────────────────────────────────── }}
      <div class="tag-grid-scroll">
        {{#if this.hasItems}}
          <table class="tag-grid">
            <thead>
              {{! ── Row 1: group labels ─────────────────────────────────── }}
              <tr class="tg-header-groups">
                {{! Name column spans header rows via rowspan }}
                <th class="sticky-col tg-col-name tg-header-name" rowspan="2">
                  {{@nameColumn}}
                </th>
                {{! Extra columns — also span both rows }}
                {{#each @extraColumns as |col|}}
                  <th class="tg-col-extra tg-header-extra" rowspan="2">{{col.label}}</th>
                {{/each}}
                {{! Tag group headers }}
                {{#each this.columnGroups as |grp|}}
                  <th
                    colspan={{grp.span}}
                    class="tg-group-header {{if (gt grp.span 1) 'tg-group-header--multi'}}"
                  >{{grp.base}}</th>
                {{/each}}
              </tr>

              {{! ── Row 2: language sub-headers ─────────────────────────── }}
              <tr class="tg-header-langs">
                {{#each this.columnGroups as |grp|}}
                  {{#each grp.cols as |col|}}
                    <th class="{{this.colClass col.tagName}}">
                      {{#if col.lang}}
                        <span class="tg-lang-label">{{col.lang}}</span>
                      {{else}}
                        {{! language-independent: blank sub-header (already labelled in row 1) }}
                      {{/if}}
                    </th>
                  {{/each}}
                {{/each}}
              </tr>
            </thead>

            <tbody>
              {{#each @items as |item|}}
                <tr>
                  <td class="sticky-col tg-name-cell">{{item.name}}</td>

                  {{#each @extraColumns as |col|}}
                    <td class="tg-extra-cell">{{this.getItemProp item col.key}}</td>
                  {{/each}}

                  {{#each this.visibleColumns as |tagName|}}
                    <td class={{this.cellClass item tagName}}>
                      {{#if (this.isLongField tagName)}}
                        <textarea
                          class="tg-input tg-input--area"
                          rows="2"
                          oninput={{fn this.onCellInput item tagName}}
                          onblur={{fn this.onCellBlur item tagName}}
                          onkeydown={{fn this.onCellKeydown item tagName}}
                        >{{this.cellValue item tagName}}</textarea>
                      {{else}}
                        <input
                          type="text"
                          class="tg-input"
                          value={{this.cellValue item tagName}}
                          oninput={{fn this.onCellInput item tagName}}
                          onblur={{fn this.onCellBlur item tagName}}
                          onkeydown={{fn this.onCellKeydown item tagName}}
                        />
                      {{/if}}
                    </td>
                  {{/each}}
                </tr>
              {{/each}}
            </tbody>
          </table>
        {{else}}
          <p class="tg-empty">
            {{#if @items}}
              No items to display.
            {{else}}
              Select a package in the sidebar to view elements.
            {{/if}}
          </p>
        {{/if}}
      </div>

    </div>
  </template>
}
