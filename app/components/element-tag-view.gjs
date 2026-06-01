import Component from '@glimmer/component';
import { action } from '@ember/object';
import { service } from '@ember/service';
import TagGrid from 'oslo-tag-editor/components/tag-grid';
import { LanguageDependentTags, LanguageIndependentTags, Languages } from 'oslo-tag-editor/oslo-tags';

// All possible language-dependent columns across all languages.
// TagGrid will hide the ones whose language isn't active.
const LANG_COLUMNS = LanguageDependentTags.flatMap((base) =>
  Languages.map((lang) => `${base}-${lang}`),
);

// Language-independent columns relevant to elements
const INDEP_COLUMNS = [
  'uri', 'name', 'package', 'parentURI', 'range',
  'status', 'literal', 'ignore', 'ignoreImplicitGeneration', 'ap-codelist',
];

const ELEMENT_TAG_COLUMNS = [...LANG_COLUMNS, ...INDEP_COLUMNS];

const EXTRA_COLUMNS = [{ label: 'Type', key: 'Object_Type' }];

export default class ElementTagView extends Component {
  @service eaDatabase;

  get items() {
    const pid = this.args.packageId;
    if (pid == null) return [];
    return this.eaDatabase
      .getElementsInPackage(pid)
      .map((e) => ({ ...e, id: e.Object_ID, name: e.Name }));
  }

  get tags() {
    const ids = this.items.map((i) => i.id);
    return this.eaDatabase.getTagsForObjects(ids);
  }

  @action
  onTagChanged(itemId, tagName, newValue) {
    this.eaDatabase.upsertTag('t_objectproperties', 'Object_ID', itemId, tagName, newValue);
  }

  <template>
    {{#if this.items.length}}
      <TagGrid
        @items={{this.items}}
        @tagColumns={{ELEMENT_TAG_COLUMNS}}
        @tags={{this.tags}}
        @nameColumn="Element"
        @extraColumns={{EXTRA_COLUMNS}}
        @onTagChanged={{this.onTagChanged}}
      />
    {{else}}
      <p class="view-placeholder">
        {{#if @packageId}}
          No Class / DataType / Enumeration elements in this package.
        {{else}}
          Select a package in the sidebar to edit element tags.
        {{/if}}
      </p>
    {{/if}}
  </template>
}
