import Component from '@glimmer/component';
import { action } from '@ember/object';
import { service } from '@ember/service';
import TagGrid from 'oslo-tag-editor/components/tag-grid';
import { LanguageDependentTags, Languages } from 'oslo-tag-editor/oslo-tags';

const LANG_COLUMNS = LanguageDependentTags.flatMap((base) =>
  Languages.map((lang) => `${base}-${lang}`),
);

// Attribute-specific language-independent tags
const INDEP_COLUMNS = ['uri', 'name', 'package', 'parentURI', 'range', 'status', 'ignore'];

const ATTRIBUTE_TAG_COLUMNS = [...LANG_COLUMNS, ...INDEP_COLUMNS];

const EXTRA_COLUMNS = [
  { label: 'Type',    key: 'Type' },
  { label: 'Element', key: 'ElementName' },
];

const TABLE = 't_attributetag';

export default class AttributeTagView extends Component {
  @service eaDatabase;
  @service osloValidator;

  get cellSeverity() {
    const prefix = `${TABLE}::`;
    const map = new Map();
    for (const [key, sev] of this.osloValidator.cellSeverityMap) {
      if (key.startsWith(prefix)) map.set(key.slice(prefix.length), sev);
    }
    return map;
  }

  get elementIds() {
    const pid = this.args.packageId;
    if (pid == null) return [];
    return this.eaDatabase
      .getElementsInPackage(pid)
      .map((e) => e.Object_ID);
  }

  get items() {
    if (!this.elementIds.length) return [];
    return this.eaDatabase
      .getAttributesForElements(this.elementIds)
      .map((a) => ({ ...a, id: a.ID, name: a.Name }));
  }

  get tags() {
    const ids = this.items.map((i) => i.id);
    return this.eaDatabase.getTagsForAttributes(ids);
  }

  @action
  onTagChanged(itemId, tagName, newValue) {
    this.eaDatabase.upsertTag('t_attributetag', 'ElementID', itemId, tagName, newValue);
  }

  <template>
    {{#if this.items.length}}
      <TagGrid
        @items={{this.items}}
        @tagColumns={{ATTRIBUTE_TAG_COLUMNS}}
        @tags={{this.tags}}
        @nameColumn="Attribute"
        @extraColumns={{EXTRA_COLUMNS}}
        @cellSeverity={{this.cellSeverity}}
        @onTagChanged={{this.onTagChanged}}
      />
    {{else}}
      <p class="view-placeholder">
        {{#if @packageId}}
          No attributes found in elements of this package.
        {{else}}
          Select a package in the sidebar to edit attribute tags.
        {{/if}}
      </p>
    {{/if}}
  </template>
}
