import Component from '@glimmer/component';
import { action } from '@ember/object';
import { service } from '@ember/service';
import TagGrid from 'oslo-tag-editor/components/tag-grid';
import { LanguageDependentTags, Languages, RoleTags } from 'oslo-tag-editor/oslo-tags';

const LANG_COLUMNS = LanguageDependentTags.flatMap((base) =>
  Languages.map((lang) => `${base}-${lang}`),
);

// Role-tag names (source.label, target.uri, …) stored in t_taggedvalue.
// Shown read-only for now — editing t_taggedvalue needs a separate upsert path.
const ROLE_COLUMNS = Object.values(RoleTags);

const CONNECTOR_TAG_COLUMNS = [
  ...LANG_COLUMNS,
  'uri', 'name', 'package', 'status', 'ignore',
  ...ROLE_COLUMNS,
];

const EXTRA_COLUMNS = [
  { label: 'Type',   key: 'Connector_Type' },
  { label: 'Source', key: 'SourceName'      },
  { label: 'Dest',   key: 'DestinationName' },
];

const TABLE = 't_connectortag';

export default class ConnectorTagView extends Component {
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

  get connectors() {
    const pid = this.args.packageId;
    if (pid == null) return [];
    return this.eaDatabase.getConnectorsForPackage(pid).map((c) => ({
      ...c,
      id:   c.Connector_ID,
      name: c.Name || `${c.SourceName} → ${c.DestinationName}`,
    }));
  }

  /** Merged Map<Connector_ID, tags[]> from both t_connectortag and t_taggedvalue role tags. */
  get tags() {
    const connectors = this.connectors;
    const connIds = connectors.map((c) => c.id);
    const eaGuids = connectors.map((c) => c.ea_guid).filter(Boolean);

    const connTags = this.eaDatabase.getTagsForConnectors(connIds);
    const roleMap  = this.eaDatabase.getConnectorRoleTags(eaGuids);

    // Build eaGuid → Connector_ID lookup so we can merge role tags into connTags
    const guidToId = new Map(connectors.map((c) => [c.ea_guid, c.id]));

    const merged = new Map(connTags);

    for (const [eaGuid, { source, target }] of roleMap) {
      const connId = guidToId.get(eaGuid);
      if (connId == null) continue;
      const existing = merged.get(connId) ?? [];
      merged.set(connId, [...existing, ...source, ...target]);
    }

    return merged;
  }

  @action
  onTagChanged(itemId, tagName, newValue) {
    // Only t_connectortag tags are editable; role tags (from t_taggedvalue) are read-only here.
    if (Object.values(RoleTags).includes(tagName)) return;
    this.eaDatabase.upsertTag('t_connectortag', 'ElementID', itemId, tagName, newValue);
  }

  <template>
    {{#if this.connectors.length}}
      <TagGrid
        @items={{this.connectors}}
        @tagColumns={{CONNECTOR_TAG_COLUMNS}}
        @tags={{this.tags}}
        @nameColumn="Connector"
        @extraColumns={{EXTRA_COLUMNS}}
        @cellSeverity={{this.cellSeverity}}
        @onTagChanged={{this.onTagChanged}}
      />
    {{else}}
      <p class="view-placeholder">
        {{#if @packageId}}
          No connectors between Class / DataType / Enumeration elements in this package.
        {{else}}
          Select a package in the sidebar to edit connector tags.
        {{/if}}
      </p>
    {{/if}}
  </template>
}
